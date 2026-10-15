// Password, browser sessions and API token. The UI and the WebSocket use a session
// cookie; scripts and Prometheus use `Authorization: Bearer <token>`.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "esp_http_server.h"

#define AUTH_DEFAULT_PASSWORD "opendsp-setup"
#define AUTH_PASSWORD_MIN 8
#define AUTH_PASSWORD_MAX 64
#define AUTH_TOKEN_CHARS 32 // hex characters of an API token or session id

typedef enum {
    AUTH_NONE = 0,
    AUTH_SESSION,
    AUTH_TOKEN,
} auth_kind_t;

esp_err_t auth_init(void);

// Who the request is, from its Cookie or Authorization header.
auth_kind_t auth_check(httpd_req_t *req);

// True until the default password has been replaced.
bool auth_password_change_required(void);

// On success writes the new session id (AUTH_TOKEN_CHARS + NUL) and returns true.
bool auth_login(const char *password, char session_id[AUTH_TOKEN_CHARS + 1]);

// Ends the session named in the request's cookie, if any.
void auth_logout(httpd_req_t *req);

// Replaces the password (checks the old one), ends every session, clears the change-required flag.
esp_err_t auth_change_password(const char *old_password, const char *new_password);

// Creates a new API token (the previous one stops working) and returns it once.
esp_err_t auth_regenerate_token(char token[AUTH_TOKEN_CHARS + 1]);
bool auth_has_token(void);

// Back to the default password, no token, no sessions.
void auth_factory_reset(void);
