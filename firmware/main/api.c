#include "api.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include "auth.h"
#include "dsp_gate.h"
#include "dsp_usb.h"
#include "fallback_page.h"
#include "http_util.h"
#include "ota.h"
#include "wifi_mgr.h"
#include "www.h"
#include "ws_bridge.h"

#define FILE_CHUNK 2048
#define LOGIN_FAILURE_DELAY_MS 500
#define LEVEL_CACHE_MS 250
#define METRICS_LEVEL_CACHE_MS 1000
#define METRICS_MAX_BYTES 3072
#define SCAN_MAX_ENTRIES 20

static const char *TAG = "api";

static const char *const CHANNEL_KEYS[DSP_CHANNELS] = {"in_a", "in_b", "in_c", "in_d", "out_1", "out_2", "out_3", "out_4"};

// ---------------------------------------------------------------- helpers

static const char *model_name(uint8_t status_byte)
{
    switch (status_byte) {
    case 0x1e:
        return "4x4 Mini";
    case 0x1f:
        return "4x4 Mini Pro";
    default:
        return "unknown";
    }
}

static const char *reset_reason_text(esp_reset_reason_t reason)
{
    switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_EXT: return "external";
    default: return "other";
    }
}

static const char *sta_state_text(wifi_sta_state_t state)
{
    switch (state) {
    case WIFI_STA_CONNECTING: return "connecting";
    case WIFI_STA_CONNECTED: return "connected";
    case WIFI_STA_FAILED: return "failed";
    default: return "not_configured";
    }
}

static double round_tenth(float value)
{
    return round(value * 10.0) / 10.0;
}

static cJSON *wifi_json(void)
{
    wifi_status_t wifi;
    wifi_mgr_get_status(&wifi);
    cJSON *root = cJSON_CreateObject();
    cJSON *ap = cJSON_AddObjectToObject(root, "ap");
    cJSON_AddBoolToObject(ap, "on", wifi.ap_on);
    cJSON_AddStringToObject(ap, "ssid", wifi.ap_ssid);
    cJSON_AddNumberToObject(ap, "clients", wifi.ap_clients);
    cJSON *sta = cJSON_AddObjectToObject(root, "station");
    cJSON_AddBoolToObject(sta, "configured", wifi.sta_configured);
    cJSON_AddStringToObject(sta, "ssid", wifi.sta_ssid);
    cJSON_AddStringToObject(sta, "state", sta_state_text(wifi.sta_state));
    cJSON_AddStringToObject(sta, "ip", wifi.sta_ip);
    if (wifi.sta_state == WIFI_STA_CONNECTED) {
        cJSON_AddNumberToObject(sta, "rssi", wifi.rssi);
    }
    cJSON_AddStringToObject(sta, "error", wifi.last_error);
    cJSON_AddStringToObject(root, "hostname", "opendsp.local");
    return root;
}

// ----------------------------------------------------------- session / auth

static esp_err_t session_get(httpd_req_t *req)
{
    const bool authenticated = auth_check(req) != AUTH_NONE;
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "authenticated", authenticated);
    cJSON_AddBoolToObject(root, "passwordChangeRequired", auth_password_change_required());
    cJSON_AddStringToObject(root, "firmware", esp_app_get_description()->version);
    cJSON_AddStringToObject(root, "ui", www_version());
    if (authenticated) {
        cJSON_AddBoolToObject(root, "tokenSet", auth_has_token());
    }
    return http_send_json(req, root);
}

static esp_err_t login_post(httpd_req_t *req)
{
    cJSON *body = http_read_json(req, 256);
    if (!body) {
        return ESP_OK;
    }
    const char *password = http_json_string(body, "password");
    char session_id[AUTH_TOKEN_CHARS + 1];
    const bool ok = password && auth_login(password, session_id);
    cJSON_Delete(body);
    if (!ok) {
        vTaskDelay(pdMS_TO_TICKS(LOGIN_FAILURE_DELAY_MS)); // slows guessing
        return http_send_error(req, "401 Unauthorized", "bad_password");
    }
    char cookie[80];
    snprintf(cookie, sizeof cookie, "sid=%s; Path=/; HttpOnly; SameSite=Strict", session_id);
    httpd_resp_set_hdr(req, "Set-Cookie", cookie);
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    cJSON_AddBoolToObject(root, "passwordChangeRequired", auth_password_change_required());
    return http_send_json(req, root);
}

static esp_err_t logout_post(httpd_req_t *req)
{
    auth_logout(req);
    httpd_resp_set_hdr(req, "Set-Cookie", "sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    return http_send_json(req, root);
}

static esp_err_t password_post(httpd_req_t *req)
{
    if (!http_authorize(req, true)) {
        return ESP_OK;
    }
    cJSON *body = http_read_json(req, 512);
    if (!body) {
        return ESP_OK;
    }
    const char *old_password = http_json_string(body, "old");
    const char *new_password = http_json_string(body, "new");
    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (old_password && new_password) {
        err = auth_change_password(old_password, new_password);
    }
    cJSON_Delete(body);
    if (err == ESP_ERR_INVALID_STATE) {
        vTaskDelay(pdMS_TO_TICKS(LOGIN_FAILURE_DELAY_MS));
        return http_send_error(req, "401 Unauthorized", "bad_password");
    }
    if (err == ESP_ERR_INVALID_ARG) {
        return http_send_error(req, "400 Bad Request", "bad_new_password");
    }
    if (err != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "save_failed");
    }
    // Every session ended, including this one.
    httpd_resp_set_hdr(req, "Set-Cookie", "sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    return http_send_json(req, root);
}

static esp_err_t token_post(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    char token[AUTH_TOKEN_CHARS + 1];
    if (auth_regenerate_token(token) != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "save_failed");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "token", token); // shown once
    return http_send_json(req, root);
}

// -------------------------------------------------- status, levels, health

static esp_err_t status_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    dsp_device_info_t info;
    dsp_gate_get_info(&info, true);
    cJSON *root = cJSON_CreateObject();
    cJSON *usb = cJSON_AddObjectToObject(root, "dsp");
    cJSON_AddBoolToObject(usb, "connected", dsp_usb_connected());
    cJSON_AddStringToObject(usb, "model", model_name(info.status_byte));
    cJSON_AddStringToObject(usb, "version", info.version);
    if (info.active_preset >= 0) {
        cJSON_AddNumberToObject(usb, "activePreset", info.active_preset);
    } else {
        cJSON_AddNullToObject(usb, "activePreset");
    }
    cJSON_AddBoolToObject(root, "controllerConnected", ws_bridge_controller_connected());
    cJSON_AddItemToObject(root, "wifi", wifi_json());
    return http_send_json(req, root);
}

static esp_err_t levels_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    dsp_levels_t levels;
    if (!dsp_gate_get_levels(&levels, LEVEL_CACHE_MS)) {
        return http_send_error(req, "503 Service Unavailable", "no_device");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "ageMs", levels.age_ms);
    cJSON *inputs = cJSON_AddArrayToObject(root, "inputs");
    cJSON *outputs = cJSON_AddArrayToObject(root, "outputs");
    for (int ch = 0; ch < DSP_CHANNELS; ch++) {
        cJSON *target = ch < 4 ? inputs : outputs;
        if (isfinite(levels.db[ch])) {
            cJSON_AddItemToArray(target, cJSON_CreateNumber(round_tenth(levels.db[ch])));
        } else {
            cJSON_AddItemToArray(target, cJSON_CreateNull()); // silence
        }
    }
    return http_send_json(req, root);
}

static esp_err_t health_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    dsp_gate_stats_t gate;
    dsp_usb_stats_t usb;
    dsp_gate_get_stats(&gate);
    dsp_usb_get_stats(&usb);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "uptimeSeconds", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddStringToObject(root, "resetReason", reset_reason_text(esp_reset_reason()));
    cJSON_AddStringToObject(root, "firmware", esp_app_get_description()->version);
    cJSON_AddStringToObject(root, "ui", www_version());
    cJSON_AddBoolToObject(root, "uiInstalled", www_mounted());
    cJSON_AddStringToObject(root, "otaSlot", ota_running_slot());
    cJSON *heap = cJSON_AddObjectToObject(root, "heap");
    cJSON_AddNumberToObject(heap, "free", esp_get_free_heap_size());
    cJSON_AddNumberToObject(heap, "minimumFree", esp_get_minimum_free_heap_size());
    cJSON *g = cJSON_AddObjectToObject(root, "transactions");
    cJSON_AddNumberToObject(g, "ok", gate.transactions);
    cJSON_AddNumberToObject(g, "nak", gate.naks);
    cJSON_AddNumberToObject(g, "timeout", gate.timeouts);
    cJSON_AddNumberToObject(g, "noDevice", gate.no_device);
    cJSON_AddNumberToObject(g, "ioError", gate.io_errors);
    cJSON_AddNumberToObject(g, "strayReports", gate.stray_reports);
    cJSON_AddNumberToObject(g, "badReports", gate.bad_reports);
    cJSON_AddNumberToObject(g, "queueDrops", gate.queue_drops);
    cJSON_AddNumberToObject(g, "lastDurationMs", gate.last_duration_ms);
    if (gate.transactions > 0) {
        cJSON_AddNumberToObject(g, "meanWriteMs", round_tenth(gate.write_us_total / 1000.0 / gate.transactions));
        cJSON_AddNumberToObject(g, "meanReplyMs", round_tenth(gate.reply_us_total / 1000.0 / gate.transactions));
        cJSON_AddNumberToObject(g, "maxDurationMs", round_tenth(gate.max_duration_us / 1000.0));
    }
    cJSON *u = cJSON_AddObjectToObject(root, "usb");
    cJSON_AddBoolToObject(u, "connected", dsp_usb_connected());
    cJSON_AddNumberToObject(u, "attachCount", usb.attach_count);
    cJSON_AddNumberToObject(u, "reportsIn", usb.reports_in);
    cJSON_AddNumberToObject(u, "reportsOut", usb.reports_out);
    cJSON_AddNumberToObject(u, "inErrors", usb.in_errors);
    cJSON_AddNumberToObject(u, "outErrors", usb.out_errors);
    cJSON_AddBoolToObject(u, "interruptOut", usb.uses_interrupt_out);
    cJSON_AddBoolToObject(root, "controllerConnected", ws_bridge_controller_connected());
    return http_send_json(req, root);
}

// ----------------------------------------------------------------- metrics

static void append_escaped(char *dst, size_t size, const char *value)
{
    size_t n = strlen(dst);
    for (; *value && n + 2 < size; value++) {
        if (*value == '"' || *value == '\\') {
            dst[n++] = '\\';
        }
        dst[n++] = *value;
    }
    dst[n] = '\0';
}

static esp_err_t metrics_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    char *out = malloc(METRICS_MAX_BYTES);
    if (!out) {
        return http_send_error(req, "500 Internal Server Error", "no_memory");
    }
    size_t n = 0;
#define EMIT(...) do { if (n < METRICS_MAX_BYTES) n += snprintf(out + n, METRICS_MAX_BYTES - n, __VA_ARGS__); } while (0)

    dsp_gate_stats_t gate;
    dsp_usb_stats_t usb;
    dsp_device_info_t info;
    dsp_levels_t levels;
    wifi_status_t wifi;
    dsp_gate_get_stats(&gate);
    dsp_usb_get_stats(&usb);
    wifi_mgr_get_status(&wifi);
    dsp_gate_get_info(&info, false);
    const bool have_levels = dsp_usb_connected() && dsp_gate_get_levels(&levels, METRICS_LEVEL_CACHE_MS);

    char labels[160] = "firmware=\"";
    append_escaped(labels, sizeof labels, esp_app_get_description()->version);
    strncat(labels, "\",ui=\"", sizeof labels - strlen(labels) - 1);
    append_escaped(labels, sizeof labels, www_version());
    strncat(labels, "\",dsp_version=\"", sizeof labels - strlen(labels) - 1);
    append_escaped(labels, sizeof labels, info.version);
    strncat(labels, "\"", sizeof labels - strlen(labels) - 1);

    EMIT("# HELP opendsp_info Build and device information.\n# TYPE opendsp_info gauge\nopendsp_info{%s} 1\n", labels);
    EMIT("# HELP opendsp_usb_connected 1 when the DSP is connected to the bridge.\n# TYPE opendsp_usb_connected gauge\n"
         "opendsp_usb_connected %d\n", dsp_usb_connected() ? 1 : 0);
    if (have_levels) {
        EMIT("# HELP opendsp_level_dbfs Channel level in dBFS (absent while silent).\n# TYPE opendsp_level_dbfs gauge\n");
        for (int ch = 0; ch < DSP_CHANNELS; ch++) {
            if (isfinite(levels.db[ch])) {
                EMIT("opendsp_level_dbfs{channel=\"%s\"} %.1f\n", CHANNEL_KEYS[ch], round_tenth(levels.db[ch]));
            }
        }
        EMIT("# HELP opendsp_level_age_seconds Age of the level reading.\n# TYPE opendsp_level_age_seconds gauge\n"
             "opendsp_level_age_seconds %.3f\n", levels.age_ms / 1000.0);
    }
    if (info.active_preset >= 0) {
        EMIT("# HELP opendsp_active_preset Active preset slot.\n# TYPE opendsp_active_preset gauge\nopendsp_active_preset %d\n",
             info.active_preset);
    }
    EMIT("# HELP opendsp_controller_connected 1 when a browser controls the DSP.\n# TYPE opendsp_controller_connected gauge\n"
         "opendsp_controller_connected %d\n", ws_bridge_controller_connected() ? 1 : 0);
    EMIT("# HELP opendsp_transactions_total DSP requests by outcome.\n# TYPE opendsp_transactions_total counter\n"
         "opendsp_transactions_total{result=\"ok\"} %u\nopendsp_transactions_total{result=\"nak\"} %u\n"
         "opendsp_transactions_total{result=\"timeout\"} %u\nopendsp_transactions_total{result=\"no_device\"} %u\n"
         "opendsp_transactions_total{result=\"io_error\"} %u\n",
         (unsigned)gate.transactions, (unsigned)gate.naks, (unsigned)gate.timeouts, (unsigned)gate.no_device,
         (unsigned)gate.io_errors);
    EMIT("# HELP opendsp_transaction_seconds_total Time spent in answered DSP requests, by phase.\n"
         "# TYPE opendsp_transaction_seconds_total counter\n"
         "opendsp_transaction_seconds_total{phase=\"write\"} %.6f\nopendsp_transaction_seconds_total{phase=\"reply\"} %.6f\n",
         gate.write_us_total / 1e6, gate.reply_us_total / 1e6);
    EMIT("# HELP opendsp_stray_reports_total Reports from the DSP that answered nothing.\n"
         "# TYPE opendsp_stray_reports_total counter\nopendsp_stray_reports_total %u\n", (unsigned)gate.stray_reports);
    EMIT("# HELP opendsp_usb_reports_total HID reports moved over USB.\n# TYPE opendsp_usb_reports_total counter\n"
         "opendsp_usb_reports_total{direction=\"in\"} %u\nopendsp_usb_reports_total{direction=\"out\"} %u\n",
         (unsigned)usb.reports_in, (unsigned)usb.reports_out);
    EMIT("# HELP opendsp_usb_errors_total Failed USB transfers.\n# TYPE opendsp_usb_errors_total counter\n"
         "opendsp_usb_errors_total{direction=\"in\"} %u\nopendsp_usb_errors_total{direction=\"out\"} %u\n",
         (unsigned)usb.in_errors, (unsigned)usb.out_errors);
    EMIT("# HELP opendsp_uptime_seconds Seconds since boot.\n# TYPE opendsp_uptime_seconds counter\n"
         "opendsp_uptime_seconds %lld\n", (long long)(esp_timer_get_time() / 1000000));
    EMIT("# HELP opendsp_heap_free_bytes Free heap.\n# TYPE opendsp_heap_free_bytes gauge\nopendsp_heap_free_bytes %u\n"
         "# HELP opendsp_heap_minimum_free_bytes Lowest free heap since boot.\n# TYPE opendsp_heap_minimum_free_bytes gauge\n"
         "opendsp_heap_minimum_free_bytes %u\n",
         (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size());
    EMIT("# HELP opendsp_wifi_station_connected 1 when joined to the registered network.\n"
         "# TYPE opendsp_wifi_station_connected gauge\nopendsp_wifi_station_connected %d\n",
         wifi.sta_state == WIFI_STA_CONNECTED ? 1 : 0);
    if (wifi.sta_state == WIFI_STA_CONNECTED) {
        EMIT("# HELP opendsp_wifi_rssi_dbm Signal strength to the registered network.\n"
             "# TYPE opendsp_wifi_rssi_dbm gauge\nopendsp_wifi_rssi_dbm %d\n", wifi.rssi);
    }
#undef EMIT
    httpd_resp_set_type(req, "text/plain; version=0.0.4; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_send(req, out, n < METRICS_MAX_BYTES ? n : METRICS_MAX_BYTES - 1);
    free(out);
    return err;
}

// -------------------------------------------------------------------- Wi-Fi

static esp_err_t wifi_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    return http_send_json(req, wifi_json());
}

static esp_err_t wifi_scan_get(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    wifi_scan_entry_t *entries = malloc(SCAN_MAX_ENTRIES * sizeof *entries);
    if (!entries) {
        return http_send_error(req, "500 Internal Server Error", "no_memory");
    }
    size_t count = 0;
    const esp_err_t err = wifi_mgr_scan(entries, SCAN_MAX_ENTRIES, &count);
    if (err != ESP_OK) {
        free(entries);
        return http_send_error(req, "503 Service Unavailable", "scan_busy");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON *list = cJSON_AddArrayToObject(root, "networks");
    for (size_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", entries[i].ssid);
        cJSON_AddNumberToObject(item, "rssi", entries[i].rssi);
        cJSON_AddBoolToObject(item, "open", entries[i].open);
        cJSON_AddItemToArray(list, item);
    }
    free(entries);
    return http_send_json(req, root);
}

static esp_err_t wifi_post(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    cJSON *body = http_read_json(req, 512);
    if (!body) {
        return ESP_OK;
    }
    const char *ssid = http_json_string(body, "ssid");
    const char *password = http_json_string(body, "password");
    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (ssid) {
        err = wifi_mgr_set_network(ssid, password ? password : "");
    }
    cJSON_Delete(body);
    if (err == ESP_ERR_INVALID_ARG) {
        return http_send_error(req, "400 Bad Request", "bad_network");
    }
    if (err != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "save_failed");
    }
    return http_send_json(req, wifi_json()); // state is "connecting"; the UI polls GET /api/wifi
}

static esp_err_t wifi_delete(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    if (wifi_mgr_forget_network() != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "save_failed");
    }
    return http_send_json(req, wifi_json());
}

static esp_err_t wifi_ap_post(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    cJSON *body = http_read_json(req, 256);
    if (!body) {
        return ESP_OK;
    }
    const char *password = http_json_string(body, "password");
    esp_err_t err = password ? wifi_mgr_set_ap_password(password) : ESP_ERR_INVALID_ARG;
    cJSON_Delete(body);
    if (err == ESP_ERR_INVALID_ARG) {
        return http_send_error(req, "400 Bad Request", "bad_password");
    }
    if (err != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "save_failed");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    return http_send_json(req, root);
}

// ------------------------------------------------------------- static files

static const char *content_type(const char *path)
{
    const char *dot = strrchr(path, '.');
    if (!dot) return "application/octet-stream";
    if (!strcmp(dot, ".html")) return "text/html; charset=utf-8";
    if (!strcmp(dot, ".js")) return "text/javascript; charset=utf-8";
    if (!strcmp(dot, ".css")) return "text/css; charset=utf-8";
    if (!strcmp(dot, ".json")) return "application/json";
    if (!strcmp(dot, ".svg")) return "image/svg+xml";
    if (!strcmp(dot, ".png")) return "image/png";
    if (!strcmp(dot, ".ico")) return "image/x-icon";
    if (!strcmp(dot, ".woff2")) return "font/woff2";
    if (!strcmp(dot, ".webmanifest")) return "application/manifest+json";
    return "application/octet-stream";
}

static bool has_extension(const char *path)
{
    const char *slash = strrchr(path, '/');
    return strchr(slash ? slash : path, '.') != NULL;
}

static esp_err_t send_file(httpd_req_t *req, const char *path)
{
    char file_path[128];
    snprintf(file_path, sizeof file_path, WWW_BASE_PATH "%s.gz", path);
    FILE *file = fopen(file_path, "rb");
    if (!file) {
        return ESP_ERR_NOT_FOUND;
    }
    char *chunk = malloc(FILE_CHUNK);
    if (!chunk) {
        fclose(file);
        return ESP_ERR_NO_MEM;
    }
    httpd_resp_set_type(req, content_type(path));
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "Cache-Control",
                       strncmp(path, "/assets/", 8) == 0 ? "public, max-age=31536000, immutable" : "no-cache");
    esp_err_t err = ESP_OK;
    size_t n;
    while (err == ESP_OK && (n = fread(chunk, 1, FILE_CHUNK, file)) > 0) {
        err = httpd_resp_send_chunk(req, chunk, n);
    }
    if (err == ESP_OK) {
        err = httpd_resp_send_chunk(req, NULL, 0);
    }
    free(chunk);
    fclose(file);
    return err;
}

static esp_err_t static_get(httpd_req_t *req)
{
    char path[96];
    const char *query = strchr(req->uri, '?');
    const size_t uri_len = query ? (size_t)(query - req->uri) : strlen(req->uri);
    if (uri_len == 0 || uri_len >= sizeof path || strstr(req->uri, "..")) {
        return http_send_error(req, "400 Bad Request", "bad_path");
    }
    memcpy(path, req->uri, uri_len);
    path[uri_len] = '\0';
    if (strcmp(path, "/") == 0) {
        strcpy(path, "/index.html");
    }
    if (strncmp(path, "/api/", 5) == 0) {
        return http_send_error(req, "404 Not Found", "not_found");
    }

    esp_err_t err = www_mounted() ? send_file(req, path) : ESP_ERR_NOT_FOUND;
    if (err == ESP_ERR_NOT_FOUND && !has_extension(path)) {
        err = www_mounted() ? send_file(req, "/index.html") : ESP_ERR_NOT_FOUND; // single-page app routes
    }
    if (err == ESP_ERR_NOT_FOUND) {
        if (strcmp(path, "/index.html") == 0 || !has_extension(path)) {
            httpd_resp_set_type(req, "text/html; charset=utf-8");
            return httpd_resp_send(req, FALLBACK_PAGE, sizeof FALLBACK_PAGE - 1);
        }
        return http_send_error(req, "404 Not Found", "not_found");
    }
    return err;
}

// ------------------------------------------------------------------- server

// Replies are tiny and the WebSocket header and payload go out as separate writes: without
// TCP_NODELAY the second one waits for the client's delayed ACK (about 40 ms per reply).
static esp_err_t on_socket_open(httpd_handle_t hd, int sockfd)
{
    const int one = 1;
    setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    return ESP_OK;
}

esp_err_t api_start(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 8192;
    config.max_uri_handlers = 24;
    config.max_open_sockets = 10;
    config.max_resp_headers = 10;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 10;
    config.send_wait_timeout = 10;
    config.keep_alive_enable = true; // notice a controller that vanished from the Wi-Fi
    config.keep_alive_idle = 10;
    config.keep_alive_interval = 5;
    config.keep_alive_count = 3;
    config.uri_match_fn = httpd_uri_match_wildcard;
    config.open_fn = on_socket_open;
    config.close_fn = ws_bridge_on_session_close;

    httpd_handle_t server;
    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        return err;
    }

    const httpd_uri_t routes[] = {
        {.uri = "/api/session", .method = HTTP_GET, .handler = session_get},
        {.uri = "/api/login", .method = HTTP_POST, .handler = login_post},
        {.uri = "/api/logout", .method = HTTP_POST, .handler = logout_post},
        {.uri = "/api/auth/password", .method = HTTP_POST, .handler = password_post},
        {.uri = "/api/auth/token", .method = HTTP_POST, .handler = token_post},
        {.uri = "/api/status", .method = HTTP_GET, .handler = status_get},
        {.uri = "/api/levels", .method = HTTP_GET, .handler = levels_get},
        {.uri = "/api/health", .method = HTTP_GET, .handler = health_get},
        {.uri = "/metrics", .method = HTTP_GET, .handler = metrics_get},
        {.uri = "/api/wifi", .method = HTTP_GET, .handler = wifi_get},
        {.uri = "/api/wifi", .method = HTTP_POST, .handler = wifi_post},
        {.uri = "/api/wifi", .method = HTTP_DELETE, .handler = wifi_delete},
        {.uri = "/api/wifi/scan", .method = HTTP_GET, .handler = wifi_scan_get},
        {.uri = "/api/wifi/ap", .method = HTTP_POST, .handler = wifi_ap_post},
    };
    for (size_t i = 0; i < sizeof routes / sizeof routes[0]; i++) {
        err = httpd_register_uri_handler(server, &routes[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "cannot register %s", routes[i].uri);
            return err;
        }
    }
    ESP_ERROR_CHECK(ws_bridge_register(server));
    ESP_ERROR_CHECK(ota_register(server));

    const httpd_uri_t files = {.uri = "/*", .method = HTTP_GET, .handler = static_get};
    ESP_ERROR_CHECK(httpd_register_uri_handler(server, &files)); // last: the catch-all
    ESP_LOGI(TAG, "HTTP server up on port %d", config.server_port);
    return ESP_OK;
}
