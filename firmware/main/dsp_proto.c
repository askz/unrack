#include "dsp_proto.h"

#include <math.h>
#include <string.h>

#define DLE 0x10
#define STX 0x02
#define ETX 0x03
#define REQUEST_ADDR 0x01
#define MAX_N (DSP_REPORT_SIZE - 7) // report = DLE STX + (N + 3) payload + DLE ETX + checksum
#define FAST_TIMEOUT_MS 150
#define LEVEL_FULL_SCALE 16777216.0f // 2^24

static uint8_t checksum(const uint8_t *payload, size_t len)
{
    uint8_t x = 0;
    for (size_t i = 0; i < len; i++) {
        x ^= payload[i];
    }
    return x ^ 1;
}

bool dsp_proto_build_request(uint8_t code, const uint8_t *data, size_t data_len, uint8_t out[DSP_REPORT_SIZE])
{
    const size_t n = 1 + data_len;
    if (n > MAX_N) {
        return false;
    }
    memset(out, 0, DSP_REPORT_SIZE);
    out[0] = DLE;
    out[1] = STX;
    out[2] = 0x00;
    out[3] = REQUEST_ADDR;
    out[4] = (uint8_t)n;
    out[5] = code;
    if (data_len) {
        memcpy(&out[6], data, data_len);
    }
    const size_t payload_len = n + 3;
    out[2 + payload_len] = DLE;
    out[3 + payload_len] = ETX;
    out[4 + payload_len] = checksum(&out[2], payload_len);
    return true;
}

// Shared framing check: [DLE STX][payload: x x N code data...][DLE ETX][checksum], payload length N + 3.
static bool frame_valid(const uint8_t *report, size_t len)
{
    if (len != DSP_REPORT_SIZE || report[0] != DLE || report[1] != STX) {
        return false;
    }
    const size_t n = report[4];
    if (n < 1 || n > MAX_N) {
        return false;
    }
    const size_t payload_len = n + 3;
    return report[2 + payload_len] == DLE && report[3 + payload_len] == ETX &&
           report[4 + payload_len] == checksum(&report[2], payload_len);
}

bool dsp_proto_request_valid(const uint8_t *report, size_t len)
{
    return frame_valid(report, len);
}

uint8_t dsp_proto_request_code(const uint8_t *report)
{
    return report[5];
}

bool dsp_proto_parse_reply(const uint8_t *report, size_t len, dsp_reply_t *out)
{
    if (!frame_valid(report, len)) {
        return false;
    }
    out->code = report[5];
    out->data = &report[6];
    out->len = (size_t)report[4] - 1;
    return true;
}

static bool is_indexed_query(uint8_t code)
{
    return code == DSP_CMD_READ_CHANNEL || code == DSP_CMD_READ_PRESET_NAME;
}

uint8_t dsp_proto_expected_reply(uint8_t request_code)
{
    switch (request_code) {
    case DSP_CMD_GET_STATUS:
    case DSP_CMD_GET_VERSION:
    case 0x52: // GET_VERSION_FW
    case DSP_CMD_GET_ACTIVE_PRESET:
    case 0x22: // GET_FLAGS_BLOCK
    case 0x2c: // GET_CONFIG
    case DSP_CMD_READ_PRESET_NAME:
    case DSP_CMD_READBACK_LEVELS:
        return request_code;
    case DSP_CMD_READ_CHANNEL:
        return 0x24; // REPLY_CHANNEL
    default:
        return DSP_REPLY_ACK;
    }
}

uint32_t dsp_proto_timeout_ms(uint8_t request_code)
{
    switch (request_code) {
    case DSP_CMD_RECALL_PRESET:
        return 1500;
    case DSP_CMD_STORE_PRESET:
        return 4000;
    default:
        return FAST_TIMEOUT_MS;
    }
}

bool dsp_proto_matches(const uint8_t *request, const dsp_reply_t *reply)
{
    const uint8_t code = dsp_proto_request_code(request);
    if (reply->code != dsp_proto_expected_reply(code)) {
        return false;
    }
    if (!is_indexed_query(code)) {
        return true;
    }
    const size_t request_data_len = (size_t)request[4] - 1;
    return request_data_len >= 1 && reply->len >= 1 && reply->data[0] == request[6];
}

bool dsp_proto_decode_levels(const dsp_reply_t *reply, float db[DSP_CHANNELS])
{
    if (reply->code != DSP_CMD_READBACK_LEVELS || reply->len < 3 * DSP_CHANNELS) {
        return false;
    }
    for (int ch = 0; ch < DSP_CHANNELS; ch++) {
        const uint8_t *p = &reply->data[3 * ch];
        // Packed as [bits23..16, bits31..24, bits15..8] of a 32-bit linear level word.
        const uint32_t word = ((uint32_t)p[1] << 24) | ((uint32_t)p[0] << 16) | ((uint32_t)p[2] << 8);
        db[ch] = 20.0f * log10f((float)word / LEVEL_FULL_SCALE);
    }
    return true;
}
