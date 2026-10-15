#include "http_util.h"

#include <stdlib.h>

#include "auth.h"

esp_err_t http_send_json(httpd_req_t *req, cJSON *root)
{
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "out of memory");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    const esp_err_t err = httpd_resp_send(req, text, HTTPD_RESP_USE_STRLEN);
    free(text);
    return err;
}

esp_err_t http_send_error(httpd_req_t *req, const char *status, const char *code)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "error", code);
    httpd_resp_set_status(req, status);
    return http_send_json(req, root);
}

cJSON *http_read_json(httpd_req_t *req, size_t max_len)
{
    if (req->content_len == 0 || req->content_len > max_len) {
        http_send_error(req, "400 Bad Request", "bad_body");
        return NULL;
    }
    char *body = malloc(req->content_len + 1);
    if (!body) {
        http_send_error(req, "500 Internal Server Error", "no_memory");
        return NULL;
    }
    size_t received = 0;
    while (received < req->content_len) {
        const int n = httpd_req_recv(req, body + received, req->content_len - received);
        if (n <= 0) {
            free(body);
            if (n == HTTPD_SOCK_ERR_TIMEOUT) {
                httpd_resp_send_err(req, HTTPD_408_REQ_TIMEOUT, NULL);
            }
            return NULL;
        }
        received += n;
    }
    body[received] = '\0';
    cJSON *json = cJSON_Parse(body);
    free(body);
    if (!cJSON_IsObject(json)) {
        cJSON_Delete(json);
        http_send_error(req, "400 Bad Request", "bad_json");
        return NULL;
    }
    return json;
}

bool http_authorize(httpd_req_t *req, bool allow_during_password_change)
{
    if (auth_check(req) == AUTH_NONE) {
        http_send_error(req, "401 Unauthorized", "unauthorized");
        return false;
    }
    if (!allow_during_password_change && auth_password_change_required()) {
        http_send_error(req, "403 Forbidden", "password_change_required");
        return false;
    }
    return true;
}

const char *http_json_string(const cJSON *object, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}
