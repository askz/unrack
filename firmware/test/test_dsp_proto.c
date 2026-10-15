// Host-side unit tests for main/dsp_proto.c. Run with `make -C firmware/test`.
// The request vectors were produced by web/src/protocol/frame.ts buildRequest.
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "dsp_proto.h"

static int checks;
#define CHECK(cond)                                                              \
    do {                                                                         \
        checks++;                                                                \
        if (!(cond)) {                                                           \
            printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);               \
            return 1;                                                            \
        }                                                                        \
    } while (0)

// Device reply: [DLE STX][0x01 0x00 N code data...][DLE ETX][xor ^ 1], zero padded.
static void make_reply(uint8_t code, const uint8_t *data, size_t len, uint8_t out[DSP_REPORT_SIZE])
{
    memset(out, 0, DSP_REPORT_SIZE);
    const size_t n = 1 + len;
    out[0] = 0x10;
    out[1] = 0x02;
    out[2] = 0x01;
    out[3] = 0x00;
    out[4] = (uint8_t)n;
    out[5] = code;
    memcpy(&out[6], data, len);
    out[2 + n + 3] = 0x10;
    out[3 + n + 3] = 0x03;
    uint8_t x = 0;
    for (size_t i = 0; i < n + 3; i++) {
        x ^= out[2 + i];
    }
    out[4 + n + 3] = x ^ 1;
}

static int test_build_matches_typescript(void)
{
    uint8_t out[DSP_REPORT_SIZE];

    const uint8_t version[] = {0x10, 0x02, 0x00, 0x01, 0x01, 0x13, 0x10, 0x03, 0x12};
    CHECK(dsp_proto_build_request(0x13, NULL, 0, out));
    CHECK(memcmp(out, version, sizeof version) == 0);
    CHECK(out[9] == 0 && out[63] == 0);

    const uint8_t channel[] = {0x10, 0x02, 0x00, 0x01, 0x02, 0x27, 0x02, 0x10, 0x03, 0x27};
    CHECK(dsp_proto_build_request(0x27, (const uint8_t[]){2}, 1, out));
    CHECK(memcmp(out, channel, sizeof channel) == 0);

    const uint8_t level[] = {0x10, 0x02, 0x00, 0x01, 0x04, 0x34, 0x04, 0x18, 0x01, 0x10, 0x03, 0x2d};
    CHECK(dsp_proto_build_request(0x34, (const uint8_t[]){4, 0x18, 0x01}, 3, out));
    CHECK(memcmp(out, level, sizeof level) == 0);
    return 0;
}

static int test_build_limits(void)
{
    uint8_t out[DSP_REPORT_SIZE];
    uint8_t big[64] = {0};
    CHECK(dsp_proto_build_request(0x30, big, 56, out)); // N = 57, the largest that fits
    CHECK(dsp_proto_request_valid(out, DSP_REPORT_SIZE));
    CHECK(!dsp_proto_build_request(0x30, big, 57, out));
    return 0;
}

static int test_request_validation(void)
{
    uint8_t out[DSP_REPORT_SIZE];
    CHECK(dsp_proto_build_request(0x13, NULL, 0, out));
    CHECK(dsp_proto_request_valid(out, DSP_REPORT_SIZE));
    CHECK(dsp_proto_request_code(out) == 0x13);
    CHECK(!dsp_proto_request_valid(out, DSP_REPORT_SIZE - 1));

    uint8_t bad[DSP_REPORT_SIZE];
    memcpy(bad, out, sizeof bad);
    bad[8] ^= 0xff; // checksum
    CHECK(!dsp_proto_request_valid(bad, DSP_REPORT_SIZE));
    memcpy(bad, out, sizeof bad);
    bad[0] = 0x11; // header
    CHECK(!dsp_proto_request_valid(bad, DSP_REPORT_SIZE));
    memcpy(bad, out, sizeof bad);
    bad[4] = 0; // N = 0
    CHECK(!dsp_proto_request_valid(bad, DSP_REPORT_SIZE));
    memcpy(bad, out, sizeof bad);
    bad[4] = 200; // N beyond the report
    CHECK(!dsp_proto_request_valid(bad, DSP_REPORT_SIZE));
    return 0;
}

static int test_parse_reply(void)
{
    uint8_t report[DSP_REPORT_SIZE];
    const uint8_t version[] = "4x4MINIPRO V010";
    make_reply(0x13, version, sizeof version - 1, report);

    dsp_reply_t reply;
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(reply.code == 0x13);
    CHECK(reply.len == sizeof version - 1);
    CHECK(memcmp(reply.data, version, reply.len) == 0);

    make_reply(0x01, NULL, 0, report); // ACK has no data
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(reply.code == DSP_REPLY_ACK && reply.len == 0);

    report[7] ^= 0x55; // corrupt the terminator
    CHECK(!dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    return 0;
}

static int test_matching(void)
{
    uint8_t request[DSP_REPORT_SIZE];
    uint8_t report[DSP_REPORT_SIZE];
    dsp_reply_t reply;

    // write -> ACK
    CHECK(dsp_proto_build_request(0x34, (const uint8_t[]){4, 1, 1}, 3, request));
    make_reply(DSP_REPLY_ACK, NULL, 0, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(dsp_proto_matches(request, &reply));
    make_reply(0x13, (const uint8_t[]){'x'}, 1, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(!dsp_proto_matches(request, &reply));

    // query echoes its code
    CHECK(dsp_proto_build_request(0x13, NULL, 0, request));
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(dsp_proto_matches(request, &reply));

    // READ_CHANNEL answers 0x24 and echoes the index
    CHECK(dsp_proto_build_request(0x27, (const uint8_t[]){3}, 1, request));
    make_reply(0x24, (const uint8_t[]){3, 9, 9}, 3, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(dsp_proto_matches(request, &reply));
    make_reply(0x24, (const uint8_t[]){2, 9, 9}, 3, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(!dsp_proto_matches(request, &reply));

    // preset name echoes code and index
    CHECK(dsp_proto_build_request(0x29, (const uint8_t[]){7}, 1, request));
    make_reply(0x29, (const uint8_t[]){7, 'A'}, 2, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(dsp_proto_matches(request, &reply));
    make_reply(0x29, (const uint8_t[]){6, 'A'}, 2, report);
    CHECK(dsp_proto_parse_reply(report, DSP_REPORT_SIZE, &reply));
    CHECK(!dsp_proto_matches(request, &reply));
    return 0;
}

static int test_timeouts(void)
{
    CHECK(dsp_proto_timeout_ms(0x40) == 150);
    CHECK(dsp_proto_timeout_ms(DSP_CMD_RECALL_PRESET) == 1500);
    CHECK(dsp_proto_timeout_ms(DSP_CMD_STORE_PRESET) == 4000);
    return 0;
}

static int test_levels(void)
{
    uint8_t data[24] = {0};
    // channel 0: word 0x10000000 (16x full scale) -> bits31..24 = 0x10, bits23..16 = 0x00, bits15..8 = 0x00
    data[0] = 0x00;
    data[1] = 0x10;
    data[2] = 0x00;
    // channel 1: silent (all zero)
    // channel 2: word 0x01000000 -> full scale (2^24) = 0 dBFS
    data[6] = 0x00;
    data[7] = 0x01;
    data[8] = 0x00;
    // channel 3: word 0x00400000 -> 2^22 -> -12.04 dBFS: bits23..16 = 0x40
    data[9] = 0x40;
    data[10] = 0x00;
    data[11] = 0x00;

    dsp_reply_t reply = {.code = 0x40, .data = data, .len = sizeof data};
    float db[DSP_CHANNELS];
    CHECK(dsp_proto_decode_levels(&reply, db));
    CHECK(fabsf(db[0] - 24.0824f) < 0.01f); // 2^28 / 2^24 = 16 -> +24.08 dB
    CHECK(isinf(db[1]) && db[1] < 0);
    CHECK(fabsf(db[2]) < 0.001f);
    CHECK(fabsf(db[3] + 12.0412f) < 0.01f);

    reply.len = 23;
    CHECK(!dsp_proto_decode_levels(&reply, db));
    reply.len = 24;
    reply.code = 0x13;
    CHECK(!dsp_proto_decode_levels(&reply, db));
    return 0;
}

int main(void)
{
    int failed = 0;
    failed |= test_build_matches_typescript();
    failed |= test_build_limits();
    failed |= test_request_validation();
    failed |= test_parse_reply();
    failed |= test_matching();
    failed |= test_timeouts();
    failed |= test_levels();
    if (failed) {
        return 1;
    }
    printf("ok, %d checks\n", checks);
    return 0;
}
