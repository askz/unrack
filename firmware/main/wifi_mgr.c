#include "wifi_mgr.h"

#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mdns.h"
#include "nvs.h"

#define NVS_NS "wifi"
#define AP_FALLBACK_MS 30000     // network lost this long: bring the access point back
#define AP_OFF_GRACE_MS 15000    // joined this long: switch the access point off (UI shows the new address first)
#define RETRY_MS 3000
#define FAILED_AFTER_ATTEMPTS 3
#define MDNS_HOSTNAME "opendsp"
#define SCAN_MAX_RECORDS 24

static const char *TAG = "wifi_mgr";

static SemaphoreHandle_t lock;
static esp_netif_t *sta_netif;
static esp_timer_handle_t fallback_timer;
static esp_timer_handle_t ap_off_timer;
static esp_timer_handle_t retry_timer;

static char ap_ssid[WIFI_MGR_SSID_MAX + 1];
static char ap_password[WIFI_MGR_PASSWORD_MAX + 1] = WIFI_MGR_DEFAULT_AP_PASSWORD;
static char sta_ssid[WIFI_MGR_SSID_MAX + 1];
static char sta_password[WIFI_MGR_PASSWORD_MAX + 1];
static bool sta_configured;
static bool ap_on = true;
static wifi_sta_state_t sta_state = WIFI_STA_NOT_CONFIGURED;
static char sta_ip[16];
static char last_error[48];
static int connect_attempts;
static bool scanning;

// ------------------------------------------------------------------ helpers

// Copies at most dst_size - 1 characters, always terminated.
static void copy_str(char *dst, size_t dst_size, const char *src)
{
    const size_t n = strnlen(src, dst_size - 1);
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static esp_err_t nvs_save_string(const char *key, const char *value)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(nvs, key, value);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static esp_err_t nvs_erase_keys(const char *const *keys, size_t count)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    for (size_t i = 0; i < count; i++) {
        const esp_err_t e = nvs_erase_key(nvs, keys[i]);
        if (e != ESP_OK && e != ESP_ERR_NVS_NOT_FOUND) err = e;
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static void nvs_load_string(nvs_handle_t nvs, const char *key, char *dst, size_t dst_size)
{
    size_t len = dst_size;
    char buffer[WIFI_MGR_PASSWORD_MAX + 1];
    if (dst_size <= sizeof buffer && nvs_get_str(nvs, key, buffer, &len) == ESP_OK) {
        copy_str(dst, dst_size, buffer);
    }
}

// The AP interface only accepts a config while it is part of the current mode.
static void apply_ap_config(void)
{
    wifi_mode_t mode;
    if (esp_wifi_get_mode(&mode) != ESP_OK || (mode != WIFI_MODE_AP && mode != WIFI_MODE_APSTA)) {
        return; // applied by apply_mode() when the AP comes up
    }
    wifi_config_t config = {0};
    copy_str((char *)config.ap.ssid, sizeof config.ap.ssid, ap_ssid);
    config.ap.ssid_len = strlen(ap_ssid);
    copy_str((char *)config.ap.password, sizeof config.ap.password, ap_password);
    config.ap.channel = 1;
    config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    config.ap.max_connection = 4;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &config));
}

static void apply_sta_config(void)
{
    wifi_config_t config = {0};
    copy_str((char *)config.sta.ssid, sizeof config.sta.ssid, sta_ssid);
    copy_str((char *)config.sta.password, sizeof config.sta.password, sta_password);
    config.sta.threshold.authmode = sta_password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    config.sta.pmf_cfg.capable = true;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
}

// The station interface stays up even without a network so that it can scan.
static void apply_mode(void)
{
    const wifi_mode_t mode = (ap_on || !sta_configured) ? WIFI_MODE_APSTA : WIFI_MODE_STA;
    ESP_ERROR_CHECK(esp_wifi_set_mode(mode));
    apply_ap_config();
    ESP_LOGI(TAG, "AP %s", mode == WIFI_MODE_APSTA ? "on" : "off");
}

static void stop_timer(esp_timer_handle_t timer)
{
    esp_timer_stop(timer); // fails harmlessly when it is not running
}

static void start_timer(esp_timer_handle_t timer, uint32_t ms)
{
    stop_timer(timer);
    esp_timer_start_once(timer, (uint64_t)ms * 1000);
}

static const char *reason_text(uint8_t reason, char *buffer, size_t size)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
        return "network not found";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        return "wrong password";
    default:
        snprintf(buffer, size, "disconnected (reason %u)", reason);
        return buffer;
    }
}

// ------------------------------------------------------------------- events

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    if (id == WIFI_EVENT_STA_START) {
        if (sta_configured) {
            esp_wifi_connect();
        }
    } else if (id == WIFI_EVENT_STA_DISCONNECTED && sta_configured) {
        const wifi_event_sta_disconnected_t *event = data;
        if (event->reason == WIFI_REASON_ASSOC_LEAVE) {
            xSemaphoreGive(lock); // our own esp_wifi_disconnect(); the caller reconnects
            return;
        }
        char text[48];
        copy_str(last_error, sizeof last_error, reason_text(event->reason, text, sizeof text));
        sta_ip[0] = '\0';
        if (sta_state == WIFI_STA_CONNECTED) {
            ESP_LOGW(TAG, "network lost (%s)", last_error);
        }
        connect_attempts++;
        sta_state = connect_attempts >= FAILED_AFTER_ATTEMPTS ? WIFI_STA_FAILED : WIFI_STA_CONNECTING;
        stop_timer(ap_off_timer);
        if (!ap_on && !esp_timer_is_active(fallback_timer)) {
            start_timer(fallback_timer, AP_FALLBACK_MS);
        }
        start_timer(retry_timer, RETRY_MS);
    }
    xSemaphoreGive(lock);
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id != IP_EVENT_STA_GOT_IP) {
        return;
    }
    const ip_event_got_ip_t *event = data;
    xSemaphoreTake(lock, portMAX_DELAY);
    snprintf(sta_ip, sizeof sta_ip, IPSTR, IP2STR(&event->ip_info.ip));
    sta_state = WIFI_STA_CONNECTED;
    connect_attempts = 0;
    last_error[0] = '\0';
    stop_timer(fallback_timer);
    stop_timer(retry_timer);
    if (ap_on) {
        start_timer(ap_off_timer, AP_OFF_GRACE_MS);
    }
    ESP_LOGI(TAG, "joined \"%s\", ip %s", sta_ssid, sta_ip);
    xSemaphoreGive(lock);
}

static void on_fallback_timer(void *arg)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    if (sta_state != WIFI_STA_CONNECTED && !ap_on) {
        ap_on = true;
        apply_mode();
    }
    xSemaphoreGive(lock);
}

static void on_ap_off_timer(void *arg)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    if (sta_state == WIFI_STA_CONNECTED && sta_configured && ap_on) {
        ap_on = false;
        apply_mode();
    }
    xSemaphoreGive(lock);
}

static void on_retry_timer(void *arg)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    if (sta_configured && sta_state != WIFI_STA_CONNECTED && !scanning) {
        esp_wifi_connect();
    }
    xSemaphoreGive(lock);
}

// ------------------------------------------------------------------- public

esp_err_t wifi_mgr_start(void)
{
    lock = xSemaphoreCreateMutex();
    if (!lock) {
        return ESP_ERR_NO_MEM;
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_ap();
    sta_netif = esp_netif_create_default_wifi_sta();

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(ap_ssid, sizeof ap_ssid, "openDSP-%02X%02X", mac[4], mac[5]);

    nvs_handle_t nvs;
    if (nvs_open(NVS_NS, NVS_READONLY, &nvs) == ESP_OK) {
        nvs_load_string(nvs, "ap_pass", ap_password, sizeof ap_password);
        nvs_load_string(nvs, "sta_ssid", sta_ssid, sizeof sta_ssid);
        nvs_load_string(nvs, "sta_pass", sta_password, sizeof sta_password);
        nvs_close(nvs);
    }
    sta_configured = sta_ssid[0] != '\0';
    sta_state = sta_configured ? WIFI_STA_CONNECTING : WIFI_STA_NOT_CONFIGURED;
    ap_on = !sta_configured; // a known network is tried first; the fallback timer brings the AP back

    const wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_ip_event, NULL));

    const esp_timer_create_args_t fallback_args = {.callback = on_fallback_timer, .name = "ap_fallback"};
    const esp_timer_create_args_t off_args = {.callback = on_ap_off_timer, .name = "ap_off"};
    const esp_timer_create_args_t retry_args = {.callback = on_retry_timer, .name = "sta_retry"};
    ESP_ERROR_CHECK(esp_timer_create(&fallback_args, &fallback_timer));
    ESP_ERROR_CHECK(esp_timer_create(&off_args, &ap_off_timer));
    ESP_ERROR_CHECK(esp_timer_create(&retry_args, &retry_timer));

    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    apply_mode(); // also applies the AP config when the AP is part of the mode
    if (sta_configured) {
        apply_sta_config();
        start_timer(fallback_timer, AP_FALLBACK_MS);
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE)); // power save adds ~100 ms of latency

    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(MDNS_HOSTNAME));
    ESP_ERROR_CHECK(mdns_instance_name_set("openDSP bridge"));
    ESP_ERROR_CHECK(mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0));

    ESP_LOGI(TAG, "AP \"%s\"%s, network \"%s\"", ap_ssid, ap_on ? "" : " (off until needed)",
             sta_configured ? sta_ssid : "(none)");
    return ESP_OK;
}

void wifi_mgr_get_status(wifi_status_t *out)
{
    memset(out, 0, sizeof *out);
    xSemaphoreTake(lock, portMAX_DELAY);
    out->ap_on = ap_on || !sta_configured;
    copy_str(out->ap_ssid, sizeof out->ap_ssid, ap_ssid);
    out->sta_configured = sta_configured;
    copy_str(out->sta_ssid, sizeof out->sta_ssid, sta_ssid);
    out->sta_state = sta_state;
    copy_str(out->sta_ip, sizeof out->sta_ip, sta_ip);
    copy_str(out->last_error, sizeof out->last_error, last_error);
    xSemaphoreGive(lock);

    wifi_ap_record_t record;
    out->rssi = (out->sta_state == WIFI_STA_CONNECTED && esp_wifi_sta_get_ap_info(&record) == ESP_OK) ? record.rssi : 0;
    wifi_sta_list_t stations;
    out->ap_clients = (out->ap_on && esp_wifi_ap_get_sta_list(&stations) == ESP_OK) ? stations.num : 0;
}

esp_err_t wifi_mgr_set_network(const char *ssid, const char *password)
{
    const size_t ssid_len = strlen(ssid);
    const size_t pass_len = strlen(password);
    if (ssid_len < 1 || ssid_len > WIFI_MGR_SSID_MAX || pass_len > WIFI_MGR_PASSWORD_MAX ||
        (pass_len != 0 && pass_len < WIFI_MGR_PASSWORD_MIN)) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t err = nvs_save_string("sta_ssid", ssid);
    if (err == ESP_OK) err = nvs_save_string("sta_pass", password);
    if (err == ESP_OK) {
        copy_str(sta_ssid, sizeof sta_ssid, ssid);
        copy_str(sta_password, sizeof sta_password, password);
        sta_configured = true;
        sta_state = WIFI_STA_CONNECTING;
        sta_ip[0] = '\0';
        last_error[0] = '\0';
        connect_attempts = 0;
        ap_on = true; // keep the access point so the UI can report the result
        stop_timer(fallback_timer);
        stop_timer(ap_off_timer);
        apply_mode();
        apply_sta_config();
        esp_wifi_disconnect();
        esp_wifi_connect();
    }
    xSemaphoreGive(lock);
    return err;
}

esp_err_t wifi_mgr_forget_network(void)
{
    static const char *const keys[] = {"sta_ssid", "sta_pass"};
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t err = nvs_erase_keys(keys, 2);
    if (err == ESP_OK) {
        sta_ssid[0] = '\0';
        sta_password[0] = '\0';
        sta_configured = false;
        sta_state = WIFI_STA_NOT_CONFIGURED;
        sta_ip[0] = '\0';
        last_error[0] = '\0';
        ap_on = true;
        stop_timer(fallback_timer);
        stop_timer(ap_off_timer);
        stop_timer(retry_timer);
        esp_wifi_disconnect();
        apply_mode();
    }
    xSemaphoreGive(lock);
    return err;
}

esp_err_t wifi_mgr_set_ap_password(const char *password)
{
    const size_t len = strlen(password);
    if (len < WIFI_MGR_PASSWORD_MIN || len > WIFI_MGR_PASSWORD_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t err = nvs_save_string("ap_pass", password);
    if (err == ESP_OK) {
        copy_str(ap_password, sizeof ap_password, password);
        apply_ap_config();
    }
    xSemaphoreGive(lock);
    return err;
}

esp_err_t wifi_mgr_scan(wifi_scan_entry_t *out, size_t max_entries, size_t *count)
{
    *count = 0;
    xSemaphoreTake(lock, portMAX_DELAY);
    scanning = true;
    xSemaphoreGive(lock);

    esp_err_t err = esp_wifi_scan_start(NULL, true);
    if (err == ESP_OK) {
        uint16_t n = SCAN_MAX_RECORDS;
        wifi_ap_record_t records[SCAN_MAX_RECORDS];
        err = esp_wifi_scan_get_ap_records(&n, records);
        for (uint16_t i = 0; err == ESP_OK && i < n; i++) {
            if (records[i].ssid[0] == '\0') {
                continue; // hidden network
            }
            const char *ssid = (const char *)records[i].ssid;
            size_t existing = 0;
            while (existing < *count && strcmp(out[existing].ssid, ssid) != 0) {
                existing++;
            }
            if (existing < *count) {
                if (records[i].rssi > out[existing].rssi) {
                    out[existing].rssi = records[i].rssi;
                }
                continue;
            }
            if (*count < max_entries) {
                copy_str(out[*count].ssid, sizeof out[*count].ssid, ssid);
                out[*count].rssi = records[i].rssi;
                out[*count].open = records[i].authmode == WIFI_AUTH_OPEN;
                (*count)++;
            }
        }
        // strongest first
        for (size_t i = 1; i < *count; i++) {
            const wifi_scan_entry_t entry = out[i];
            size_t j = i;
            while (j > 0 && out[j - 1].rssi < entry.rssi) {
                out[j] = out[j - 1];
                j--;
            }
            out[j] = entry;
        }
    }

    xSemaphoreTake(lock, portMAX_DELAY);
    scanning = false;
    xSemaphoreGive(lock);
    return err == ESP_OK ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t wifi_mgr_factory_reset(void)
{
    static const char *const keys[] = {"ap_pass"};
    esp_err_t err = nvs_erase_keys(keys, 1);
    if (err == ESP_OK) {
        err = wifi_mgr_forget_network();
    }
    if (err == ESP_OK) {
        xSemaphoreTake(lock, portMAX_DELAY);
        copy_str(ap_password, sizeof ap_password, WIFI_MGR_DEFAULT_AP_PASSWORD);
        apply_ap_config();
        xSemaphoreGive(lock);
    }
    return err;
}
