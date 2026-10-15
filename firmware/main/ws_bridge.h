// /ws: the browser's pipe to the DSP. Binary frames are raw 64-byte reports (requests in,
// replies out); text frames are small JSON status messages. One controller at a time:
// a new connection takes over and the old one is told {"type":"evicted"}.
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "esp_http_server.h"

esp_err_t ws_bridge_register(httpd_handle_t server);
// The server's close_fn: forgets the controller and closes the socket.
void ws_bridge_on_session_close(httpd_handle_t server, int sockfd);

bool ws_bridge_controller_connected(void);

// Tell the controller the DSP appeared or went away (gate listener).
void ws_bridge_notify_usb(bool connected);
