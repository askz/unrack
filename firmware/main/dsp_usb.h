// USB host side: finds the DSP (0168:0821) and moves raw 64-byte HID reports.
// The HID class driver is not used: it cannot write to the interrupt OUT endpoint,
// which is where WebHID/hidraw send requests.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "dsp_proto.h"

// Called from the USB client task for every inbound report. Must not block.
typedef void (*dsp_usb_report_cb_t)(const uint8_t report[DSP_REPORT_SIZE]);
// Called from the USB client task when the DSP becomes usable or goes away. Must not block.
typedef void (*dsp_usb_state_cb_t)(bool connected);

typedef struct {
    uint32_t attach_count;
    uint32_t reports_in;
    uint32_t in_errors;
    uint32_t reports_out;
    uint32_t out_errors;
    bool uses_interrupt_out; // false: reports go out as HID SET_REPORT on the control endpoint
} dsp_usb_stats_t;

esp_err_t dsp_usb_start(dsp_usb_report_cb_t on_report, dsp_usb_state_cb_t on_state);

bool dsp_usb_connected(void);

// Send one report and wait for the transfer to finish (not for the device's reply).
esp_err_t dsp_usb_write(const uint8_t report[DSP_REPORT_SIZE]);

void dsp_usb_get_stats(dsp_usb_stats_t *out);
