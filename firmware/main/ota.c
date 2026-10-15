#include "ota.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "http_util.h"
#include "www.h"

#define CHUNK_SIZE 4096
#define SECTOR_SIZE 4096
#define LITTLEFS_MAGIC "littlefs"
#define LITTLEFS_MAGIC_OFFSET 8
#define REBOOT_DELAY_MS 1000

static const char *TAG = "ota";

static void reboot_cb(void *arg)
{
    esp_restart();
}

static void schedule_reboot(void)
{
    static esp_timer_handle_t timer;
    const esp_timer_create_args_t args = {.callback = reboot_cb, .name = "reboot"};
    if (!timer && esp_timer_create(&args, &timer) != ESP_OK) {
        esp_restart();
    }
    esp_timer_start_once(timer, (uint64_t)REBOOT_DELAY_MS * 1000);
}

// Receive up to `want` bytes; returns the count received (less only at the end of the body).
static int recv_some(httpd_req_t *req, uint8_t *buffer, size_t want)
{
    size_t got = 0;
    while (got < want) {
        const int n = httpd_req_recv(req, (char *)buffer + got, want - got);
        if (n == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (n <= 0) {
            return n < 0 ? -1 : (int)got;
        }
        got += n;
    }
    return (int)got;
}

static esp_err_t send_ok_and_reboot(httpd_req_t *req)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    cJSON_AddTrueToObject(root, "rebooting");
    const esp_err_t err = http_send_json(req, root);
    schedule_reboot();
    return err;
}

// --------------------------------------------------------------- firmware

static esp_err_t firmware_handler(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target || req->content_len == 0) {
        return http_send_error(req, "400 Bad Request", "bad_body");
    }
    if (req->content_len > target->size) {
        return http_send_error(req, "413 Payload Too Large", "image_too_large");
    }

    uint8_t *chunk = malloc(CHUNK_SIZE);
    if (!chunk) {
        return http_send_error(req, "500 Internal Server Error", "no_memory");
    }
    esp_ota_handle_t handle;
    if (esp_ota_begin(target, req->content_len, &handle) != ESP_OK) {
        free(chunk);
        return http_send_error(req, "500 Internal Server Error", "ota_begin_failed");
    }
    ESP_LOGI(TAG, "firmware upload, %u bytes into %s", (unsigned)req->content_len, target->label);

    size_t remaining = req->content_len;
    while (remaining > 0) {
        const int n = recv_some(req, chunk, remaining < CHUNK_SIZE ? remaining : CHUNK_SIZE);
        if (n <= 0 || esp_ota_write(handle, chunk, n) != ESP_OK) {
            esp_ota_abort(handle);
            free(chunk);
            return n <= 0 ? ESP_FAIL : http_send_error(req, "400 Bad Request", "invalid_image");
        }
        remaining -= n;
    }
    free(chunk);
    if (esp_ota_end(handle) != ESP_OK) {
        return http_send_error(req, "400 Bad Request", "invalid_image");
    }
    if (esp_ota_set_boot_partition(target) != ESP_OK) {
        return http_send_error(req, "500 Internal Server Error", "set_boot_failed");
    }
    ESP_LOGI(TAG, "firmware written, rebooting into %s", target->label);
    return send_ok_and_reboot(req);
}

// --------------------------------------------------------------------- UI

static esp_err_t ui_handler(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    const esp_partition_t *partition = www_partition();
    if (!partition || req->content_len == 0) {
        return http_send_error(req, "400 Bad Request", "bad_body");
    }
    if (req->content_len > partition->size) {
        return http_send_error(req, "413 Payload Too Large", "image_too_large");
    }

    uint8_t *chunk = malloc(CHUNK_SIZE);
    if (!chunk) {
        return http_send_error(req, "500 Internal Server Error", "no_memory");
    }
    size_t remaining = req->content_len;
    int n = recv_some(req, chunk, remaining < CHUNK_SIZE ? remaining : CHUNK_SIZE);
    // Check the image before touching the working UI.
    if (n < LITTLEFS_MAGIC_OFFSET + 8 || memcmp(chunk + LITTLEFS_MAGIC_OFFSET, LITTLEFS_MAGIC, 8) != 0) {
        free(chunk);
        if (n < 0) {
            return ESP_FAIL;
        }
        return http_send_error(req, "400 Bad Request", "not_a_littlefs_image");
    }

    ESP_LOGI(TAG, "UI upload, %u bytes", (unsigned)req->content_len);
    www_unmount();
    const size_t erase_len = (req->content_len + SECTOR_SIZE - 1) / SECTOR_SIZE * SECTOR_SIZE;
    esp_err_t err = esp_partition_erase_range(partition, 0, erase_len);
    size_t offset = 0;
    while (err == ESP_OK && n > 0) {
        err = esp_partition_write(partition, offset, chunk, n);
        offset += n;
        remaining -= n;
        if (err != ESP_OK || remaining == 0) {
            break;
        }
        n = recv_some(req, chunk, remaining < CHUNK_SIZE ? remaining : CHUNK_SIZE);
    }
    free(chunk);
    if (err != ESP_OK || remaining != 0) {
        ESP_LOGE(TAG, "UI upload failed: %s, %u bytes missing", esp_err_to_name(err), (unsigned)remaining);
        www_mount(); // normally fails now; the fallback page then offers a new upload
        return err == ESP_OK ? ESP_FAIL : http_send_error(req, "500 Internal Server Error", "flash_write_failed");
    }
    if (www_mount() != ESP_OK) {
        return http_send_error(req, "400 Bad Request", "invalid_image");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddTrueToObject(root, "ok");
    cJSON_AddStringToObject(root, "version", www_version());
    return http_send_json(req, root);
}

static esp_err_t reboot_handler(httpd_req_t *req)
{
    if (!http_authorize(req, false)) {
        return ESP_OK;
    }
    return send_ok_and_reboot(req);
}

// ------------------------------------------------------------------ public

esp_err_t ota_register(httpd_handle_t server)
{
    const httpd_uri_t uris[] = {
        {.uri = "/api/update/firmware", .method = HTTP_POST, .handler = firmware_handler},
        {.uri = "/api/update/ui", .method = HTTP_POST, .handler = ui_handler},
        {.uri = "/api/reboot", .method = HTTP_POST, .handler = reboot_handler},
    };
    for (size_t i = 0; i < sizeof uris / sizeof uris[0]; i++) {
        const esp_err_t err = httpd_register_uri_handler(server, &uris[i]);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

void ota_mark_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "new firmware is healthy, cancelling rollback");
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

const char *ota_running_slot(void)
{
    return esp_ota_get_running_partition()->label;
}
