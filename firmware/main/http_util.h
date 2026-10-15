#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"
#include "esp_http_server.h"

// Send `root` as the JSON response and free it.
esp_err_t http_send_json(httpd_req_t *req, cJSON *root);

// {"error": code} with an HTTP status line such as "400 Bad Request".
esp_err_t http_send_error(httpd_req_t *req, const char *status, const char *code);

// Reads a JSON object body of at most `max_len` bytes. On failure the error response is sent
// and NULL is returned.
cJSON *http_read_json(httpd_req_t *req, size_t max_len);

// Allows the request when it carries a valid session or API token. Otherwise sends 401, or 403
// while the default password is still in place (unless `allow_during_password_change`) and
// returns false.
bool http_authorize(httpd_req_t *req, bool allow_during_password_change);

// String field of a JSON object, or NULL.
const char *http_json_string(const cJSON *object, const char *key);
