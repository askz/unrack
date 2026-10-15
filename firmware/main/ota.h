// Firmware and UI uploads, reboot. Both uploads take the raw file as the request body:
//   POST /api/update/firmware   build/opendsp-bridge.bin
//   POST /api/update/ui         build/www.bin (the LittleFS image of firmware/www)
#pragma once

#include "esp_err.h"
#include "esp_http_server.h"

esp_err_t ota_register(httpd_handle_t server);

// Mark the running image valid (cancels the rollback of a freshly updated firmware).
void ota_mark_valid(void);

// "ota_0" / "ota_1" and whether the running image is still unconfirmed.
const char *ota_running_slot(void);
