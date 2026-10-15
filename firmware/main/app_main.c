#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "api.h"
#include "auth.h"
#include "dsp_gate.h"
#include "dsp_usb.h"
#include "ota.h"
#include "wifi_mgr.h"
#include "www.h"
#include "ws_bridge.h"

#define BOOT_BUTTON GPIO_NUM_0
#define FACTORY_RESET_HOLD_MS 5000
#define BUTTON_POLL_MS 100
#define HEALTHY_AFTER_MS 5000

static const char *TAG = "opendsp";

// Holding BOOT for 5 s clears the Wi-Fi network, both passwords and the API token.
static void factory_reset_task(void *arg)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BOOT_BUTTON,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&io));
    int held_ms = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
        held_ms = gpio_get_level(BOOT_BUTTON) == 0 ? held_ms + BUTTON_POLL_MS : 0;
        if (held_ms >= FACTORY_RESET_HOLD_MS) {
            ESP_LOGW(TAG, "BOOT held: factory reset");
            auth_factory_reset();
            wifi_mgr_factory_reset();
            vTaskDelay(pdMS_TO_TICKS(500));
            esp_restart();
        }
    }
}

// A freshly updated image that gets this far and keeps running is confirmed; one that
// crashes before it is rolled back by the bootloader.
static void healthy_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(HEALTHY_AFTER_MS));
    ota_mark_valid();
    vTaskDelete(NULL);
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(wifi_mgr_start()); // also creates the default event loop
    ESP_ERROR_CHECK(auth_init());      // after Wi-Fi so the random numbers are properly seeded
    www_mount();                       // failure is fine: the fallback page offers an upload

    dsp_gate_set_usb_listener(ws_bridge_notify_usb);
    ESP_ERROR_CHECK(dsp_gate_start());
    ESP_ERROR_CHECK(dsp_usb_start(dsp_gate_on_report, dsp_gate_on_usb_state));
    ESP_ERROR_CHECK(api_start());

    xTaskCreate(factory_reset_task, "factory_reset", 2048, NULL, 3, NULL);
    xTaskCreate(healthy_task, "healthy", 2048, NULL, 3, NULL);
    ESP_LOGI(TAG, "openDSP bridge running");
}
