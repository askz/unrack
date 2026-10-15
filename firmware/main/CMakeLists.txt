idf_component_register(
    SRCS "app_main.c" "api.c" "auth.c" "dsp_gate.c" "dsp_proto.c" "dsp_usb.c" "http_util.c" "ota.c" "wifi_mgr.c"
         "www.c" "ws_bridge.c"
    INCLUDE_DIRS "."
    REQUIRES app_update esp_app_format esp_driver_gpio esp_event esp_http_server esp_netif esp_partition esp_system
             esp_timer esp_wifi mbedtls nvs_flash usb cjson mdns littlefs
)

# Image of firmware/www (the gzipped UI from `npm run build:esp`) for the `www` partition.
# build/www.bin is also what POST /api/update/ui accepts.
littlefs_create_partition_image(www ${PROJECT_DIR}/www FLASH_IN_PROJECT)
