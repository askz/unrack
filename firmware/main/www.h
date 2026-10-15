// The web UI lives in the `www` LittleFS partition, mounted read-only at /www.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "esp_partition.h"

#define WWW_BASE_PATH "/www"

esp_err_t www_mount(void);
void www_unmount(void);
bool www_mounted(void);

// Contents of /www/VERSION written by the UI build, or "none".
const char *www_version(void);

const esp_partition_t *www_partition(void);
