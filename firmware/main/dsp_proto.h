// Pure (no ESP-IDF) helpers for the DSP's 64-byte HID reports. They mirror
// web/src/protocol/{frame,exchange,readback}.ts and are unit tested on the host
// (firmware/test).
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define DSP_REPORT_SIZE 64
#define DSP_CHANNELS 8

// Command / reply codes (web/src/protocol/commands.ts).
#define DSP_CMD_GET_STATUS 0x10
#define DSP_CMD_GET_VERSION 0x13
#define DSP_CMD_GET_ACTIVE_PRESET 0x14
#define DSP_CMD_RECALL_PRESET 0x20
#define DSP_CMD_STORE_PRESET 0x21
#define DSP_CMD_READ_CHANNEL 0x27
#define DSP_CMD_READ_PRESET_NAME 0x29
#define DSP_CMD_READBACK_LEVELS 0x40
#define DSP_REPLY_ACK 0x01
#define DSP_REPLY_NAK 0x02

typedef struct {
    uint8_t code;
    const uint8_t *data; // points into the report passed to dsp_proto_parse
    size_t len;
} dsp_reply_t;

// Build a request report (zero padded to 64 bytes). Returns false if the data does not fit.
bool dsp_proto_build_request(uint8_t code, const uint8_t *data, size_t data_len, uint8_t out[DSP_REPORT_SIZE]);

// True if the report is a well-framed request with a valid checksum.
bool dsp_proto_request_valid(const uint8_t *report, size_t len);

uint8_t dsp_proto_request_code(const uint8_t *report);

// Parse a device report: framing and checksum must be valid.
bool dsp_proto_parse_reply(const uint8_t *report, size_t len, dsp_reply_t *out);

// Reply code the device answers a request code with (queries echo, writes are acked).
uint8_t dsp_proto_expected_reply(uint8_t request_code);

// Milliseconds to wait for one attempt (recall and store are slow).
uint32_t dsp_proto_timeout_ms(uint8_t request_code);

// True if `reply` answers the request report `request` (code, plus echoed index for indexed queries).
bool dsp_proto_matches(const uint8_t *request, const dsp_reply_t *reply);

// Decode a 0x40 reply into dBFS per channel (In A-D, Out 1-4; -INFINITY when silent).
bool dsp_proto_decode_levels(const dsp_reply_t *reply, float db[DSP_CHANNELS]);
