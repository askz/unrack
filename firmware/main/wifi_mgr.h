// Wi-Fi: the access point `openDSP-XXXX` is on by default. Once a home network is
// registered and joined the access point is switched off, and it comes back if the
// network stays lost for 30 s.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define WIFI_MGR_DEFAULT_AP_PASSWORD "opendsp-setup"
#define WIFI_MGR_SSID_MAX 32
#define WIFI_MGR_PASSWORD_MIN 8
#define WIFI_MGR_PASSWORD_MAX 63

typedef enum {
    WIFI_STA_NOT_CONFIGURED,
    WIFI_STA_CONNECTING,
    WIFI_STA_CONNECTED,
    WIFI_STA_FAILED, // could not join yet; still retrying in the background
} wifi_sta_state_t;

typedef struct {
    bool ap_on;
    char ap_ssid[WIFI_MGR_SSID_MAX + 1];
    int ap_clients;
    bool sta_configured;
    char sta_ssid[WIFI_MGR_SSID_MAX + 1];
    wifi_sta_state_t sta_state;
    char sta_ip[16];
    int rssi;
    char last_error[48];
} wifi_status_t;

typedef struct {
    char ssid[WIFI_MGR_SSID_MAX + 1];
    int8_t rssi;
    bool open;
} wifi_scan_entry_t;

esp_err_t wifi_mgr_start(void);
void wifi_mgr_get_status(wifi_status_t *out);

// Register (and start joining) a network. The access point stays on until it is joined.
// An empty password means an open network.
esp_err_t wifi_mgr_set_network(const char *ssid, const char *password);
esp_err_t wifi_mgr_forget_network(void);

// 8..63 characters.
esp_err_t wifi_mgr_set_ap_password(const char *password);

// Blocking scan (about 2 s). ESP_ERR_INVALID_STATE if the radio is busy.
esp_err_t wifi_mgr_scan(wifi_scan_entry_t *out, size_t max_entries, size_t *count);

// Forget the network and restore the default access point password.
esp_err_t wifi_mgr_factory_reset(void);
