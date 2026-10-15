#include "dsp_gate.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "dsp_usb.h"

#define REQUEST_QUEUE_DEPTH 16
#define REPORT_QUEUE_DEPTH 8

typedef enum { MSG_REQUEST, MSG_USB_STATE } msg_type_t;

typedef struct {
    msg_type_t type;
    uint8_t frame[DSP_REPORT_SIZE];
    dsp_gate_done_cb_t done;
    void *ctx;
} msg_t;

static const char *TAG = "dsp_gate";

static QueueHandle_t request_queue;
static QueueHandle_t report_queue;
static dsp_gate_usb_listener_t usb_listener;
static dsp_gate_stats_t stats;

static portMUX_TYPE cache_lock = portMUX_INITIALIZER_UNLOCKED;
static dsp_device_info_t info = {.active_preset = -1};
static float meter_db[DSP_CHANNELS];
static int64_t meter_time_us; // 0 = never

// ------------------------------------------------------------------- caches

static void cache_levels(const dsp_reply_t *reply)
{
    float db[DSP_CHANNELS];
    if (!dsp_proto_decode_levels(reply, db)) {
        return;
    }
    portENTER_CRITICAL(&cache_lock);
    memcpy(meter_db, db, sizeof db);
    meter_time_us = esp_timer_get_time();
    portEXIT_CRITICAL(&cache_lock);
}

static void cache_info(uint8_t request_code, const uint8_t *request, const dsp_reply_t *reply)
{
    portENTER_CRITICAL(&cache_lock);
    if (request_code == DSP_CMD_GET_STATUS && reply->len >= 1) {
        info.status_byte = reply->data[0];
    } else if (request_code == DSP_CMD_GET_VERSION) {
        size_t n = 0;
        for (; n < reply->len && n < sizeof info.version - 1; n++) {
            const uint8_t c = reply->data[n];
            if (c < 0x20 || c > 0x7e) {
                break;
            }
            info.version[n] = (char)c;
        }
        info.version[n] = '\0';
    } else if (request_code == DSP_CMD_GET_ACTIVE_PRESET && reply->len >= 1) {
        info.active_preset = reply->data[0];
    } else if ((request_code == DSP_CMD_RECALL_PRESET || request_code == DSP_CMD_STORE_PRESET) &&
               reply->code == DSP_REPLY_ACK && request[4] >= 2) {
        info.active_preset = request[6]; // the device tracks the active slot across recall and store
    }
    portEXIT_CRITICAL(&cache_lock);
}

static void invalidate_caches(void)
{
    portENTER_CRITICAL(&cache_lock);
    memset(&info, 0, sizeof info);
    info.active_preset = -1;
    meter_time_us = 0;
    portEXIT_CRITICAL(&cache_lock);
}

// -------------------------------------------------------------- transactions

static void flush_reports(void)
{
    uint8_t stale[DSP_REPORT_SIZE];
    while (xQueueReceive(report_queue, stale, 0) == pdTRUE) {
        stats.stray_reports++;
    }
}

static dsp_gate_result_t transact(const uint8_t *frame, uint8_t *reply_out)
{
    if (!dsp_usb_connected()) {
        stats.no_device++;
        return DSP_GATE_NO_DEVICE;
    }
    const uint8_t code = dsp_proto_request_code(frame);
    const int64_t started = esp_timer_get_time();
    const int64_t deadline = started + (int64_t)dsp_proto_timeout_ms(code) * 1000;

    flush_reports(); // a late reply to an earlier attempt must not answer this one
    if (dsp_usb_write(frame) != ESP_OK) {
        stats.io_errors++;
        return DSP_GATE_IO_ERROR;
    }
    const int64_t written = esp_timer_get_time();

    for (;;) {
        const int64_t remaining_us = deadline - esp_timer_get_time();
        uint8_t report[DSP_REPORT_SIZE];
        if (remaining_us <= 0 || xQueueReceive(report_queue, report, pdMS_TO_TICKS((remaining_us + 999) / 1000)) != pdTRUE) {
            stats.timeouts++;
            return DSP_GATE_TIMEOUT;
        }
        dsp_reply_t reply;
        if (!dsp_proto_parse_reply(report, sizeof report, &reply)) {
            stats.bad_reports++;
            continue;
        }
        const bool matched = dsp_proto_matches(frame, &reply);
        if (!matched && reply.code != DSP_REPLY_NAK) {
            stats.stray_reports++;
            continue;
        }
        if (matched) {
            if (code == DSP_CMD_READBACK_LEVELS) {
                cache_levels(&reply);
            }
            cache_info(code, frame, &reply);
        } else {
            stats.naks++;
        }
        const int64_t finished = esp_timer_get_time();
        const uint32_t duration_us = (uint32_t)(finished - started);
        stats.transactions++;
        stats.last_duration_ms = duration_us / 1000;
        stats.write_us_total += (uint64_t)(written - started);
        stats.reply_us_total += (uint64_t)(finished - written);
        if (duration_us > stats.max_duration_us) {
            stats.max_duration_us = duration_us;
        }
        memcpy(reply_out, report, DSP_REPORT_SIZE);
        return DSP_GATE_OK;
    }
}

static void read_device_info(void)
{
    static const uint8_t queries[] = {DSP_CMD_GET_STATUS, DSP_CMD_GET_VERSION, DSP_CMD_GET_ACTIVE_PRESET};
    for (size_t i = 0; i < sizeof queries; i++) {
        uint8_t frame[DSP_REPORT_SIZE];
        uint8_t reply[DSP_REPORT_SIZE];
        dsp_proto_build_request(queries[i], NULL, 0, frame);
        dsp_gate_result_t result = DSP_GATE_TIMEOUT;
        for (int attempt = 0; attempt < 3 && result == DSP_GATE_TIMEOUT; attempt++) {
            result = transact(frame, reply);
        }
        if (result != DSP_GATE_OK) {
            ESP_LOGW(TAG, "info query 0x%02x failed (%d)", queries[i], result);
        }
    }
    portENTER_CRITICAL(&cache_lock);
    info.valid = info.version[0] != '\0';
    portEXIT_CRITICAL(&cache_lock);
    ESP_LOGI(TAG, "DSP version \"%s\", status byte 0x%02x, preset %d", info.version, info.status_byte, info.active_preset);
}

static void gate_task(void *arg)
{
    bool was_connected = false;
    msg_t msg;
    for (;;) {
        xQueueReceive(request_queue, &msg, portMAX_DELAY);
        if (msg.type == MSG_USB_STATE) {
            const bool connected = dsp_usb_connected();
            if (connected == was_connected) {
                continue;
            }
            was_connected = connected;
            if (connected) {
                read_device_info();
            } else {
                invalidate_caches();
            }
            if (usb_listener) {
                usb_listener(connected);
            }
            continue;
        }
        uint8_t reply[DSP_REPORT_SIZE];
        const dsp_gate_result_t result = transact(msg.frame, reply);
        if (msg.done) {
            msg.done(msg.ctx, result, result == DSP_GATE_OK ? reply : NULL);
        }
    }
}

// ------------------------------------------------------------------- public

esp_err_t dsp_gate_start(void)
{
    request_queue = xQueueCreate(REQUEST_QUEUE_DEPTH, sizeof(msg_t));
    report_queue = xQueueCreate(REPORT_QUEUE_DEPTH, DSP_REPORT_SIZE);
    if (!request_queue || !report_queue) {
        return ESP_ERR_NO_MEM;
    }
    return xTaskCreate(gate_task, "dsp_gate", 5120, NULL, 6, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

void dsp_gate_on_report(const uint8_t report[DSP_REPORT_SIZE])
{
    if (xQueueSend(report_queue, report, 0) != pdTRUE) {
        stats.bad_reports++; // nobody is draining: count it, the newest report is dropped
    }
}

void dsp_gate_on_usb_state(bool connected)
{
    (void)connected; // the gate task reads the live state when it handles the message
    msg_t msg = {.type = MSG_USB_STATE};
    xQueueSend(request_queue, &msg, pdMS_TO_TICKS(50));
}

void dsp_gate_set_usb_listener(dsp_gate_usb_listener_t listener)
{
    usb_listener = listener;
}

esp_err_t dsp_gate_submit(const uint8_t request[DSP_REPORT_SIZE], dsp_gate_done_cb_t done, void *ctx)
{
    if (!dsp_proto_request_valid(request, DSP_REPORT_SIZE)) {
        return ESP_ERR_INVALID_ARG;
    }
    msg_t msg = {.type = MSG_REQUEST, .done = done, .ctx = ctx};
    memcpy(msg.frame, request, DSP_REPORT_SIZE);
    if (xQueueSend(request_queue, &msg, 0) != pdTRUE) {
        stats.queue_drops++;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

typedef struct {
    SemaphoreHandle_t done;
    dsp_gate_result_t result;
    uint8_t *reply_out;
} sync_ctx_t;

static void sync_done(void *ctx, dsp_gate_result_t result, const uint8_t *reply)
{
    sync_ctx_t *sync = ctx;
    sync->result = result;
    if (reply) {
        memcpy(sync->reply_out, reply, DSP_REPORT_SIZE);
    }
    xSemaphoreGive(sync->done);
}

dsp_gate_result_t dsp_gate_request_sync(const uint8_t request[DSP_REPORT_SIZE], uint8_t reply_out[DSP_REPORT_SIZE])
{
    sync_ctx_t sync = {.done = xSemaphoreCreateBinary(), .result = DSP_GATE_IO_ERROR, .reply_out = reply_out};
    if (!sync.done) {
        return DSP_GATE_IO_ERROR;
    }
    // Every accepted request is completed by the gate task (its waits are bounded),
    // so waiting without a timeout cannot leave a dangling stack pointer behind.
    if (dsp_gate_submit(request, sync_done, &sync) == ESP_OK) {
        xSemaphoreTake(sync.done, portMAX_DELAY);
    }
    vSemaphoreDelete(sync.done);
    return sync.result;
}

void dsp_gate_get_stats(dsp_gate_stats_t *out)
{
    *out = stats;
}

bool dsp_gate_get_info(dsp_device_info_t *out, bool refresh)
{
    if (refresh && dsp_usb_connected()) {
        uint8_t frame[DSP_REPORT_SIZE];
        uint8_t reply[DSP_REPORT_SIZE];
        dsp_proto_build_request(DSP_CMD_GET_ACTIVE_PRESET, NULL, 0, frame);
        dsp_gate_request_sync(frame, reply); // updates the cache on success
    }
    portENTER_CRITICAL(&cache_lock);
    *out = info;
    portEXIT_CRITICAL(&cache_lock);
    return out->valid;
}

bool dsp_gate_get_levels(dsp_levels_t *out, uint32_t max_age_ms)
{
    for (int pass = 0; pass < 2; pass++) {
        portENTER_CRITICAL(&cache_lock);
        const int64_t time_us = meter_time_us;
        const int64_t age_us = esp_timer_get_time() - time_us;
        // The second pass runs right after a poll, so any cached value is fresh enough.
        const bool fresh = time_us != 0 && (pass == 1 || age_us <= (int64_t)max_age_ms * 1000);
        if (fresh) {
            memcpy(out->db, meter_db, sizeof out->db);
            out->age_ms = (uint32_t)(age_us / 1000);
        }
        portEXIT_CRITICAL(&cache_lock);
        if (fresh) {
            return true;
        }
        if (pass == 0) {
            uint8_t frame[DSP_REPORT_SIZE];
            uint8_t reply[DSP_REPORT_SIZE];
            dsp_proto_build_request(DSP_CMD_READBACK_LEVELS, NULL, 0, frame);
            if (dsp_gate_request_sync(frame, reply) != DSP_GATE_OK) {
                return false;
            }
        }
    }
    return false;
}
