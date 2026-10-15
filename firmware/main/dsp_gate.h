// The DSP handles one transaction at a time and silently drops a frame sent while it is
// busy. Everything that talks to it (the browser's WebSocket, the HTTP endpoints, the
// attach-time info queries) goes through this gate: one request on the wire at a time,
// each reply routed to whoever sent the request.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "dsp_proto.h"

typedef enum {
    DSP_GATE_OK = 0,       // a matching reply (which may be a NAK) arrived
    DSP_GATE_TIMEOUT,      // no matching reply in time
    DSP_GATE_NO_DEVICE,    // the DSP is not connected
    DSP_GATE_IO_ERROR,     // the USB write failed
} dsp_gate_result_t;

// Runs in the gate task. `reply` is a 64-byte report when result is DSP_GATE_OK, else NULL.
typedef void (*dsp_gate_done_cb_t)(void *ctx, dsp_gate_result_t result, const uint8_t *reply);
typedef void (*dsp_gate_usb_listener_t)(bool connected);

typedef struct {
    uint32_t transactions;   // requests that got a reply
    uint32_t naks;           // of which NAKs
    uint32_t timeouts;
    uint32_t no_device;
    uint32_t io_errors;
    uint32_t stray_reports;  // valid reports that answered nothing
    uint32_t bad_reports;    // framing or checksum errors
    uint32_t queue_drops;    // requests refused because the queue was full
    uint32_t last_duration_ms;
    // Time of answered transactions, split at the end of the USB write: the write itself
    // (host to DSP) and the wait for the reply (the DSP's processing plus the IN report).
    uint64_t write_us_total;
    uint64_t reply_us_total;
    uint32_t max_duration_us;
} dsp_gate_stats_t;

typedef struct {
    bool valid;
    uint8_t status_byte;     // model byte of GET_STATUS (0x1e Mini, 0x1f Mini Pro)
    char version[32];
    int active_preset;       // -1 unknown
} dsp_device_info_t;

typedef struct {
    float db[DSP_CHANNELS];  // In A-D, Out 1-4, dBFS (-INFINITY when silent)
    uint32_t age_ms;
} dsp_levels_t;

esp_err_t dsp_gate_start(void);

// Pass these to dsp_usb_start().
void dsp_gate_on_report(const uint8_t report[DSP_REPORT_SIZE]);
void dsp_gate_on_usb_state(bool connected);

// Called from the gate task after the device info has been (re)read on attach, and on detach.
void dsp_gate_set_usb_listener(dsp_gate_usb_listener_t listener);

// Queue a request without blocking. ESP_ERR_INVALID_ARG for a malformed frame,
// ESP_ERR_NO_MEM when the queue is full.
esp_err_t dsp_gate_submit(const uint8_t request[DSP_REPORT_SIZE], dsp_gate_done_cb_t done, void *ctx);

// Blocking form for HTTP handlers. Never call it from the gate task.
dsp_gate_result_t dsp_gate_request_sync(const uint8_t request[DSP_REPORT_SIZE], uint8_t reply_out[DSP_REPORT_SIZE]);

void dsp_gate_get_stats(dsp_gate_stats_t *out);

// Cached model, version and active preset. With `refresh` the active preset is queried first.
bool dsp_gate_get_info(dsp_device_info_t *out, bool refresh);

// Levels from the meter cache if it is younger than `max_age_ms`, else one fresh 0x40 poll.
bool dsp_gate_get_levels(dsp_levels_t *out, uint32_t max_age_ms);
