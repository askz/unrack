#include "auth.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "psa/crypto.h"

#define NVS_NS "auth"
#define SALT_LEN 16
#define HASH_LEN 32
#define SESSION_ID_LEN 16 // bytes, AUTH_TOKEN_CHARS hex characters
#define MAX_SESSIONS 6
#define COOKIE_NAME "sid="

static const char *TAG = "auth";

static SemaphoreHandle_t lock;
static uint8_t salt[SALT_LEN];
static uint8_t password_hash[HASH_LEN];
static uint8_t token_hash[HASH_LEN];
static bool token_set;
static bool change_required;

static struct {
    bool used;
    uint8_t id[SESSION_ID_LEN];
} sessions[MAX_SESSIONS];
static int next_session_slot;

// ------------------------------------------------------------------ helpers

static bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t len)
{
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff == 0;
}

static bool sha256(const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len, uint8_t out[HASH_LEN])
{
    uint8_t buffer[SALT_LEN + AUTH_PASSWORD_MAX];
    if (a_len + b_len > sizeof buffer) {
        return false;
    }
    memcpy(buffer, a, a_len);
    memcpy(buffer + a_len, b, b_len);
    size_t out_len = 0;
    const psa_status_t status = psa_hash_compute(PSA_ALG_SHA_256, buffer, a_len + b_len, out, HASH_LEN, &out_len);
    memset(buffer, 0, sizeof buffer);
    return status == PSA_SUCCESS && out_len == HASH_LEN;
}

static bool hash_password(const char *password, uint8_t out[HASH_LEN])
{
    return sha256(salt, SALT_LEN, (const uint8_t *)password, strlen(password), out);
}

static void to_hex(const uint8_t *in, size_t len, char *out)
{
    for (size_t i = 0; i < len; i++) {
        sprintf(out + 2 * i, "%02x", in[i]);
    }
}

static bool from_hex(const char *in, uint8_t *out, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        unsigned value;
        if (sscanf(in + 2 * i, "%2x", &value) != 1) {
            return false;
        }
        out[i] = (uint8_t)value;
    }
    return true;
}

static bool is_hex_token(const char *s)
{
    if (strlen(s) != AUTH_TOKEN_CHARS) {
        return false;
    }
    for (size_t i = 0; i < AUTH_TOKEN_CHARS; i++) {
        const char c = s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------- persistence

static esp_err_t save_password_state(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_blob(nvs, "salt", salt, SALT_LEN);
    if (err == ESP_OK) err = nvs_set_blob(nvs, "hash", password_hash, HASH_LEN);
    if (err == ESP_OK) err = nvs_set_u8(nvs, "chg", change_required ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static esp_err_t save_token(void)
{
    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    if (token_set) {
        err = nvs_set_blob(nvs, "tok", token_hash, HASH_LEN);
    } else {
        err = nvs_erase_key(nvs, "tok");
        if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    }
    if (err == ESP_OK) err = nvs_commit(nvs);
    nvs_close(nvs);
    return err;
}

static esp_err_t set_default_password(void)
{
    esp_fill_random(salt, SALT_LEN);
    if (!hash_password(AUTH_DEFAULT_PASSWORD, password_hash)) {
        return ESP_FAIL;
    }
    change_required = true;
    return save_password_state();
}

esp_err_t auth_init(void)
{
    lock = xSemaphoreCreateMutex();
    if (!lock) {
        return ESP_ERR_NO_MEM;
    }
    if (psa_crypto_init() != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_crypto_init failed");
        return ESP_FAIL;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NS, NVS_READWRITE, &nvs) != ESP_OK) {
        return ESP_FAIL;
    }
    size_t salt_len = SALT_LEN, hash_len = HASH_LEN, token_len = HASH_LEN;
    uint8_t chg = 1;
    const bool have_password = nvs_get_blob(nvs, "salt", salt, &salt_len) == ESP_OK && salt_len == SALT_LEN &&
                               nvs_get_blob(nvs, "hash", password_hash, &hash_len) == ESP_OK && hash_len == HASH_LEN;
    nvs_get_u8(nvs, "chg", &chg);
    change_required = chg != 0;
    token_set = nvs_get_blob(nvs, "tok", token_hash, &token_len) == ESP_OK && token_len == HASH_LEN;
    nvs_close(nvs);

    if (!have_password) {
        ESP_LOGW(TAG, "first boot: password set to the default");
        return set_default_password();
    }
    return ESP_OK;
}

// ------------------------------------------------------------------- checks

static bool cookie_session_id(httpd_req_t *req, uint8_t id[SESSION_ID_LEN])
{
    char header[160];
    if (httpd_req_get_hdr_value_str(req, "Cookie", header, sizeof header) != ESP_OK) {
        return false;
    }
    const char *at = header;
    while ((at = strstr(at, COOKIE_NAME)) != NULL) {
        if (at == header || at[-1] == ' ' || at[-1] == ';') {
            const char *value = at + strlen(COOKIE_NAME);
            char hex[AUTH_TOKEN_CHARS + 1] = {0};
            strncpy(hex, value, AUTH_TOKEN_CHARS);
            return is_hex_token(hex) && from_hex(hex, id, SESSION_ID_LEN);
        }
        at += strlen(COOKIE_NAME);
    }
    return false;
}

auth_kind_t auth_check(httpd_req_t *req)
{
    auth_kind_t kind = AUTH_NONE;
    xSemaphoreTake(lock, portMAX_DELAY);

    char header[96];
    if (token_set && httpd_req_get_hdr_value_str(req, "Authorization", header, sizeof header) == ESP_OK &&
        strncmp(header, "Bearer ", 7) == 0 && is_hex_token(header + 7)) {
        uint8_t hash[HASH_LEN];
        if (sha256((const uint8_t *)"", 0, (const uint8_t *)(header + 7), AUTH_TOKEN_CHARS, hash) &&
            constant_time_equal(hash, token_hash, HASH_LEN)) {
            kind = AUTH_TOKEN;
        }
    }
    uint8_t id[SESSION_ID_LEN];
    if (kind == AUTH_NONE && cookie_session_id(req, id)) {
        for (int i = 0; i < MAX_SESSIONS; i++) {
            if (sessions[i].used && constant_time_equal(sessions[i].id, id, SESSION_ID_LEN)) {
                kind = AUTH_SESSION;
            }
        }
    }
    xSemaphoreGive(lock);
    return kind;
}

bool auth_password_change_required(void)
{
    return change_required;
}

bool auth_login(const char *password, char session_id[AUTH_TOKEN_CHARS + 1])
{
    uint8_t hash[HASH_LEN];
    xSemaphoreTake(lock, portMAX_DELAY);
    bool ok = strlen(password) <= AUTH_PASSWORD_MAX && hash_password(password, hash) &&
              constant_time_equal(hash, password_hash, HASH_LEN);
    if (ok) {
        const int slot = next_session_slot;
        next_session_slot = (next_session_slot + 1) % MAX_SESSIONS;
        esp_fill_random(sessions[slot].id, SESSION_ID_LEN);
        sessions[slot].used = true;
        to_hex(sessions[slot].id, SESSION_ID_LEN, session_id);
    }
    xSemaphoreGive(lock);
    return ok;
}

void auth_logout(httpd_req_t *req)
{
    uint8_t id[SESSION_ID_LEN];
    if (!cookie_session_id(req, id)) {
        return;
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sessions[i].used && constant_time_equal(sessions[i].id, id, SESSION_ID_LEN)) {
            memset(&sessions[i], 0, sizeof sessions[i]);
        }
    }
    xSemaphoreGive(lock);
}

esp_err_t auth_change_password(const char *old_password, const char *new_password)
{
    const size_t new_len = strlen(new_password);
    if (new_len < AUTH_PASSWORD_MIN || new_len > AUTH_PASSWORD_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t hash[HASH_LEN];
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t err = ESP_ERR_INVALID_STATE; // wrong old password
    if (strlen(old_password) <= AUTH_PASSWORD_MAX && hash_password(old_password, hash) &&
        constant_time_equal(hash, password_hash, HASH_LEN)) {
        esp_fill_random(salt, SALT_LEN);
        if (hash_password(new_password, password_hash)) {
            change_required = false;
            memset(sessions, 0, sizeof sessions);
            err = save_password_state();
        } else {
            err = ESP_FAIL;
        }
    }
    xSemaphoreGive(lock);
    return err;
}

esp_err_t auth_regenerate_token(char token[AUTH_TOKEN_CHARS + 1])
{
    uint8_t raw[AUTH_TOKEN_CHARS / 2];
    esp_fill_random(raw, sizeof raw);
    to_hex(raw, sizeof raw, token);
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t err = sha256((const uint8_t *)"", 0, (const uint8_t *)token, AUTH_TOKEN_CHARS, token_hash) ? ESP_OK : ESP_FAIL;
    if (err == ESP_OK) {
        token_set = true;
        err = save_token();
    }
    xSemaphoreGive(lock);
    return err;
}

bool auth_has_token(void)
{
    return token_set;
}

void auth_factory_reset(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    memset(sessions, 0, sizeof sessions);
    token_set = false;
    save_token();
    set_default_password();
    xSemaphoreGive(lock);
}
