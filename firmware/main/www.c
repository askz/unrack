#include "www.h"

#include <stdio.h>
#include <string.h>

#include "esp_littlefs.h"
#include "esp_log.h"

#define PARTITION_LABEL "www"

static const char *TAG = "www";
static bool mounted;
static char version[32] = "none";

esp_err_t www_mount(void)
{
    if (mounted) {
        return ESP_OK;
    }
    const esp_vfs_littlefs_conf_t conf = {
        .base_path = WWW_BASE_PATH,
        .partition_label = PARTITION_LABEL,
        .format_if_mount_failed = false,
        .read_only = true,
    };
    const esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "cannot mount the UI partition (%s); upload a UI image from the fallback page", esp_err_to_name(err));
        strcpy(version, "none");
        return err;
    }
    mounted = true;
    strcpy(version, "unknown");
    FILE *file = fopen(WWW_BASE_PATH "/VERSION", "r");
    if (file) {
        if (fgets(version, sizeof version, file)) {
            version[strcspn(version, "\r\n")] = '\0';
        }
        fclose(file);
    }
    ESP_LOGI(TAG, "UI mounted, version %s", version);
    return ESP_OK;
}

void www_unmount(void)
{
    if (mounted) {
        esp_vfs_littlefs_unregister(PARTITION_LABEL);
        mounted = false;
        strcpy(version, "none");
    }
}

bool www_mounted(void)
{
    return mounted;
}

const char *www_version(void)
{
    return version;
}

const esp_partition_t *www_partition(void)
{
    return esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, PARTITION_LABEL);
}
