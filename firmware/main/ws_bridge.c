#include "ws_bridge.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "lwip/sockets.h"

#include "esp_app_desc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "dsp_gate.h"
#include "dsp_usb.h"
#include "http_util.h"

#define MAX_DISCARD_BYTES 256

static const char *TAG = "ws_bridge";

static httpd_handle_t server;
static SemaphoreHandle_t lock;
static int controller_fd = -1;
static uint32_t controller_gen; // bumps on every takeover or close, so late replies are dropped

// ------------------------------------------------------------------- sending

#define WS_OPCODE_TEXT 0x1
#define WS_OPCODE_BINARY 0x2
#define WS_FINAL 0x80
#define MAX_SEND_PAYLOAD 200

// Writes one unmasked server frame with a single non-blocking send(): no hop through the
// server task and one TCP segment per reply. Every frame to a controller goes through here
// with `lock` held, so frames never interleave and the socket cannot be closed meanwhile
// (the close callback takes the same lock). A socket that cannot take a whole frame is
// closed: the browser reconnects, which beats a corrupted stream.
static void send_locked(int fd, uint8_t opcode, const void *data, size_t len)
{
    if (len > MAX_SEND_PAYLOAD) {
        return;
    }
    uint8_t frame[4 + MAX_SEND_PAYLOAD];
    size_t header = 2;
    frame[0] = WS_FINAL | opcode;
    if (len < 126) {
        frame[1] = (uint8_t)len;
    } else {
        frame[1] = 126;
        frame[2] = (uint8_t)(len >> 8);
        frame[3] = (uint8_t)len;
        header = 4;
    }
    memcpy(frame + header, data, len);
    const ssize_t sent = send(fd, frame, header + len, MSG_DONTWAIT);
    if (sent != (ssize_t)(header + len)) {
        ESP_LOGW(TAG, "fd %d cannot take a frame (%d), closing it", fd, (int)sent);
        httpd_sess_trigger_close(server, fd);
    }
}

static void send_text_locked(int fd, const char *text)
{
    send_locked(fd, WS_OPCODE_TEXT, text, strlen(text));
}

static void send_hello_locked(int fd)
{
    dsp_device_info_t info;
    dsp_gate_get_info(&info, false);
    char text[160];
    snprintf(text, sizeof text, "{\"type\":\"hello\",\"usb\":%s,\"version\":\"%s\",\"fw\":\"%s\"}",
             dsp_usb_connected() ? "true" : "false", info.version, esp_app_get_description()->version);
    send_text_locked(fd, text);
}

// ---------------------------------------------------------------- gate reply

static void on_gate_done(void *ctx, dsp_gate_result_t result, const uint8_t *reply)
{
    if (result != DSP_GATE_OK) {
        return; // no reply: the browser's own timeout and retry apply
    }
    const uint32_t gen = (uint32_t)(uintptr_t)ctx;
    xSemaphoreTake(lock, portMAX_DELAY);
    if (gen == controller_gen && controller_fd >= 0) {
        send_locked(controller_fd, WS_OPCODE_BINARY, reply, DSP_REPORT_SIZE);
    }
    xSemaphoreGive(lock);
}

// ------------------------------------------------------------ session events

static esp_err_t ws_pre_handshake(httpd_req_t *req)
{
    return http_authorize(req, false) ? ESP_OK : ESP_FAIL; // sends the 401/403 itself
}

static esp_err_t ws_post_handshake(httpd_req_t *req)
{
    const int fd = httpd_req_to_sockfd(req);
    xSemaphoreTake(lock, portMAX_DELAY);
    const int old_fd = controller_fd;
    controller_fd = fd;
    controller_gen++;
    if (old_fd >= 0 && old_fd != fd) {
        ESP_LOGI(TAG, "controller fd %d taken over by fd %d", old_fd, fd);
        send_text_locked(old_fd, "{\"type\":\"evicted\"}");
        httpd_sess_trigger_close(server, old_fd);
    }
    send_hello_locked(fd);
    xSemaphoreGive(lock);
    return ESP_OK;
}

void ws_bridge_on_session_close(httpd_handle_t hd, int sockfd)
{
    if (lock) {
        xSemaphoreTake(lock, portMAX_DELAY);
        if (sockfd == controller_fd) {
            controller_fd = -1;
            controller_gen++;
        }
        xSemaphoreGive(lock);
    }
    close(sockfd);
}

// -------------------------------------------------------------------- frames

static esp_err_t ws_handler(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        return ESP_OK;
    }
    httpd_ws_frame_t frame = {0};
    esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
    if (err != ESP_OK) {
        return err;
    }
    const int fd = httpd_req_to_sockfd(req);
    if (frame.type == HTTPD_WS_TYPE_BINARY && frame.len == DSP_REPORT_SIZE) {
        uint8_t report[DSP_REPORT_SIZE];
        frame.payload = report;
        err = httpd_ws_recv_frame(req, &frame, sizeof report);
        if (err != ESP_OK) {
            return err;
        }
        xSemaphoreTake(lock, portMAX_DELAY);
        const bool is_controller = fd == controller_fd;
        const uint32_t gen = controller_gen;
        xSemaphoreGive(lock);
        if (is_controller) {
            dsp_gate_submit(report, on_gate_done, (void *)(uintptr_t)gen); // drops silently if malformed or busy
        }
        return ESP_OK;
    }
    if (frame.len == 0) {
        return ESP_OK;
    }
    if (frame.len > MAX_DISCARD_BYTES) {
        return ESP_FAIL; // nothing legitimate is this large: drop the connection
    }
    uint8_t discard[MAX_DISCARD_BYTES];
    frame.payload = discard;
    return httpd_ws_recv_frame(req, &frame, sizeof discard);
}

// ------------------------------------------------------------------- public

esp_err_t ws_bridge_register(httpd_handle_t hd)
{
    if (!lock) {
        lock = xSemaphoreCreateMutex();
    }
    server = hd;
    const httpd_uri_t uri = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = ws_handler,
        .is_websocket = true,
        .ws_pre_handshake_cb = ws_pre_handshake,
        .ws_post_handshake_cb = ws_post_handshake,
    };
    return httpd_register_uri_handler(hd, &uri);
}

bool ws_bridge_controller_connected(void)
{
    return controller_fd >= 0;
}

void ws_bridge_notify_usb(bool connected)
{
    if (!lock || !server) {
        return;
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    if (controller_fd >= 0) {
        send_text_locked(controller_fd,
                         connected ? "{\"type\":\"usb\",\"connected\":true}" : "{\"type\":\"usb\",\"connected\":false}");
    }
    xSemaphoreGive(lock);
}
