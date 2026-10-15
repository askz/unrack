#include "dsp_usb.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_helpers.h"
#include "usb/usb_host.h"

#define DSP_VID 0x0168
#define DSP_PID 0x0821
#define HID_SET_REPORT 0x09
#define HID_REPORT_TYPE_OUTPUT 2
#define WRITE_TIMEOUT_MS 200
#define MAX_CONSECUTIVE_IN_ERRORS 25

static const char *TAG = "dsp_usb";

static struct {
    dsp_usb_report_cb_t on_report;
    dsp_usb_state_cb_t on_state;
    usb_host_client_handle_t client;

    // Current device. All of it is touched only by the client task, except
    // `connected`, `closing` and the OUT transfer, which dsp_usb_write also uses.
    usb_device_handle_t dev;
    uint8_t interface_number;
    uint8_t ep_in;
    uint8_t ep_out;
    bool has_out;
    uint16_t mps_in;
    usb_transfer_t *in;
    usb_transfer_t *out;
    bool in_pending;
    bool out_pending;
    uint32_t consecutive_in_errors;
    volatile bool connected;
    volatile bool closing;

    SemaphoreHandle_t write_lock;
    SemaphoreHandle_t write_done;
    volatile usb_transfer_status_t write_status;

    dsp_usb_stats_t stats;
} s;

static void close_device(void);

// ---------------------------------------------------------------- transfers

static void in_transfer_cb(usb_transfer_t *transfer)
{
    s.in_pending = false;
    const usb_transfer_status_t status = transfer->status;

    if (status == USB_TRANSFER_STATUS_COMPLETED) {
        s.consecutive_in_errors = 0;
        if (transfer->actual_num_bytes > 0 && s.on_report && !s.closing) {
            uint8_t report[DSP_REPORT_SIZE] = {0};
            int n = transfer->actual_num_bytes;
            memcpy(report, transfer->data_buffer, n > DSP_REPORT_SIZE ? DSP_REPORT_SIZE : (size_t)n);
            s.stats.reports_in++;
            s.on_report(report);
        }
    } else if (status != USB_TRANSFER_STATUS_CANCELED && status != USB_TRANSFER_STATUS_NO_DEVICE) {
        s.stats.in_errors++;
        s.consecutive_in_errors++;
        if (status == USB_TRANSFER_STATUS_STALL) {
            usb_host_endpoint_clear(s.dev, s.ep_in);
        }
    }

    const bool gone = status == USB_TRANSFER_STATUS_CANCELED || status == USB_TRANSFER_STATUS_NO_DEVICE;
    if (!s.closing && !gone) {
        if (s.consecutive_in_errors >= MAX_CONSECUTIVE_IN_ERRORS) {
            ESP_LOGE(TAG, "IN endpoint keeps failing (%d), giving up on the device", (int)status);
            s.closing = true;
        } else {
            if (s.consecutive_in_errors > 0) {
                vTaskDelay(pdMS_TO_TICKS(5));
            }
            s.in_pending = true;
            if (usb_host_transfer_submit(s.in) != ESP_OK) {
                s.in_pending = false;
                s.closing = true;
            }
            return;
        }
    }
    if (s.closing) {
        // A device we gave up on (or that went away) is closed once nothing is in flight.
        s.connected = false;
        if (!s.in_pending && !s.out_pending) {
            close_device();
        }
    }
}

static void out_transfer_cb(usb_transfer_t *transfer)
{
    s.out_pending = false;
    s.write_status = transfer->status;
    xSemaphoreGive(s.write_done);
    if (s.closing && !s.in_pending) {
        close_device();
    }
}

// ----------------------------------------------------------- device lifetime

static bool find_hid_endpoints(const usb_config_desc_t *config)
{
    int offset = 0;
    const usb_standard_desc_t *desc = (const usb_standard_desc_t *)config;
    while ((desc = usb_parse_next_descriptor_of_type(desc, config->wTotalLength, USB_B_DESCRIPTOR_TYPE_INTERFACE, &offset))) {
        const usb_intf_desc_t *intf = (const usb_intf_desc_t *)desc;
        if (intf->bInterfaceClass != USB_CLASS_HID || intf->bAlternateSetting != 0) {
            continue;
        }
        bool have_in = false;
        bool have_out = false;
        uint8_t ep_in = 0;
        uint8_t ep_out = 0;
        uint16_t mps_in = 0;
        for (int i = 0; i < intf->bNumEndpoints; i++) {
            int ep_offset = offset;
            const usb_ep_desc_t *ep = usb_parse_endpoint_descriptor_by_index(intf, i, config->wTotalLength, &ep_offset);
            if (!ep || USB_EP_DESC_GET_XFERTYPE(ep) != USB_TRANSFER_TYPE_INTR) {
                continue;
            }
            if (USB_EP_DESC_GET_EP_DIR(ep)) {
                if (!have_in) {
                    have_in = true;
                    ep_in = ep->bEndpointAddress;
                    mps_in = USB_EP_DESC_GET_MPS(ep);
                }
            } else if (!have_out) {
                have_out = true;
                ep_out = ep->bEndpointAddress;
            }
        }
        if (have_in) {
            s.interface_number = intf->bInterfaceNumber;
            s.ep_in = ep_in;
            s.mps_in = mps_in;
            s.has_out = have_out;
            s.ep_out = ep_out;
            return true;
        }
    }
    return false;
}

static void release_resources(void)
{
    if (s.in) {
        usb_host_transfer_free(s.in);
        s.in = NULL;
    }
    if (s.out) {
        usb_host_transfer_free(s.out);
        s.out = NULL;
    }
}

static void close_device(void)
{
    if (!s.dev) {
        return;
    }
    // Wait out a writer that is still inside dsp_usb_write before freeing the OUT transfer.
    xSemaphoreTake(s.write_lock, portMAX_DELAY);
    s.connected = false;
    usb_host_interface_release(s.client, s.dev, s.interface_number);
    release_resources();
    usb_host_device_close(s.client, s.dev);
    s.dev = NULL;
    s.closing = false;
    s.in_pending = false;
    s.out_pending = false;
    xSemaphoreGive(s.write_lock);
    ESP_LOGI(TAG, "DSP closed");
    if (s.on_state) {
        s.on_state(false);
    }
}

// Start closing: cancel what is in flight; the transfer callbacks finish the job.
static void begin_close(void)
{
    if (!s.dev || s.closing) {
        return;
    }
    s.closing = true;
    s.connected = false;
    if (s.in_pending) {
        usb_host_endpoint_halt(s.dev, s.ep_in);
        usb_host_endpoint_flush(s.dev, s.ep_in);
    }
    if (s.out_pending && s.has_out) {
        usb_host_endpoint_halt(s.dev, s.ep_out);
        usb_host_endpoint_flush(s.dev, s.ep_out);
    }
    if (!s.in_pending && !s.out_pending) {
        close_device();
    }
}

static void open_device(uint8_t address)
{
    if (s.dev) {
        return; // one DSP at a time
    }
    usb_device_handle_t dev;
    if (usb_host_device_open(s.client, address, &dev) != ESP_OK) {
        ESP_LOGW(TAG, "cannot open device at address %u", address);
        return;
    }
    const usb_device_desc_t *device_desc;
    ESP_ERROR_CHECK(usb_host_get_device_descriptor(dev, &device_desc));
    if (device_desc->idVendor != DSP_VID || device_desc->idProduct != DSP_PID) {
        ESP_LOGI(TAG, "ignoring %04x:%04x", device_desc->idVendor, device_desc->idProduct);
        usb_host_device_close(s.client, dev);
        return;
    }
    const usb_config_desc_t *config;
    ESP_ERROR_CHECK(usb_host_get_active_config_descriptor(dev, &config));
    usb_print_config_descriptor(config, NULL);

    s.dev = dev;
    s.closing = false;
    if (!find_hid_endpoints(config)) {
        ESP_LOGE(TAG, "DSP has no HID interface with an interrupt IN endpoint");
        goto fail;
    }
    if (usb_host_interface_claim(s.client, dev, s.interface_number, 0) != ESP_OK) {
        ESP_LOGE(TAG, "cannot claim interface %u", s.interface_number);
        goto fail;
    }

    const size_t in_bytes = ((DSP_REPORT_SIZE + s.mps_in - 1) / s.mps_in) * s.mps_in;
    if (usb_host_transfer_alloc(in_bytes, 0, &s.in) != ESP_OK ||
        usb_host_transfer_alloc(USB_SETUP_PACKET_SIZE + DSP_REPORT_SIZE, 0, &s.out) != ESP_OK) {
        ESP_LOGE(TAG, "out of memory for transfers");
        usb_host_interface_release(s.client, dev, s.interface_number);
        goto fail;
    }
    s.in->device_handle = dev;
    s.in->bEndpointAddress = s.ep_in;
    s.in->num_bytes = (int)in_bytes;
    s.in->callback = in_transfer_cb;
    s.out->device_handle = dev;
    s.out->callback = out_transfer_cb;
    s.stats.uses_interrupt_out = s.has_out;
    s.consecutive_in_errors = 0;

    ESP_LOGI(TAG, "DSP found: interface %u, IN 0x%02x (mps %u), %s", s.interface_number, s.ep_in, s.mps_in,
             s.has_out ? "interrupt OUT" : "no OUT endpoint, writing with SET_REPORT");
    if (s.has_out) {
        ESP_LOGI(TAG, "OUT endpoint 0x%02x", s.ep_out);
    }

    s.in_pending = true;
    if (usb_host_transfer_submit(s.in) != ESP_OK) {
        s.in_pending = false;
        ESP_LOGE(TAG, "cannot start the IN transfer");
        usb_host_interface_release(s.client, dev, s.interface_number);
        goto fail;
    }
    s.stats.attach_count++;
    s.connected = true;
    if (s.on_state) {
        s.on_state(true);
    }
    return;

fail:
    release_resources();
    usb_host_device_close(s.client, dev);
    s.dev = NULL;
}

static void client_event_cb(const usb_host_client_event_msg_t *msg, void *arg)
{
    switch (msg->event) {
    case USB_HOST_CLIENT_EVENT_NEW_DEV:
        open_device(msg->new_dev.address);
        break;
    case USB_HOST_CLIENT_EVENT_DEV_GONE:
        if (msg->dev_gone.dev_hdl == s.dev) {
            ESP_LOGI(TAG, "DSP unplugged");
            begin_close();
        }
        break;
    default:
        break;
    }
}

static void daemon_task(void *arg)
{
    for (;;) {
        uint32_t flags = 0;
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
        if (flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            usb_host_device_free_all();
        }
    }
}

static void client_task(void *arg)
{
    const usb_host_client_config_t client_config = {
        .is_synchronous = false,
        .max_num_event_msg = 5,
        .async = {.client_event_callback = client_event_cb, .callback_arg = NULL},
    };
    ESP_ERROR_CHECK(usb_host_client_register(&client_config, &s.client));

    // Devices that were already plugged in before the client registered.
    uint8_t addresses[4];
    int count = 0;
    if (usb_host_device_addr_list_fill(sizeof addresses, addresses, &count) == ESP_OK) {
        for (int i = 0; i < count; i++) {
            open_device(addresses[i]);
        }
    }
    for (;;) {
        usb_host_client_handle_events(s.client, portMAX_DELAY);
        if (s.closing && s.dev && !s.in_pending && !s.out_pending) {
            close_device();
        }
    }
}

// ------------------------------------------------------------------- public

esp_err_t dsp_usb_start(dsp_usb_report_cb_t on_report, dsp_usb_state_cb_t on_state)
{
    s.on_report = on_report;
    s.on_state = on_state;
    s.write_lock = xSemaphoreCreateMutex();
    s.write_done = xSemaphoreCreateBinary();
    if (!s.write_lock || !s.write_done) {
        return ESP_ERR_NO_MEM;
    }
    const usb_host_config_t host_config = {.skip_phy_setup = false, .intr_flags = ESP_INTR_FLAG_LEVEL1};
    ESP_RETURN_ON_ERROR(usb_host_install(&host_config), TAG, "usb_host_install");
    if (xTaskCreate(daemon_task, "usb_daemon", 4096, NULL, 5, NULL) != pdPASS ||
        xTaskCreate(client_task, "usb_client", 6144, NULL, 5, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool dsp_usb_connected(void)
{
    return s.connected;
}

esp_err_t dsp_usb_write(const uint8_t report[DSP_REPORT_SIZE])
{
    xSemaphoreTake(s.write_lock, portMAX_DELAY);
    esp_err_t result = ESP_ERR_INVALID_STATE;
    if (s.connected && !s.closing && s.dev && s.out) {
        xSemaphoreTake(s.write_done, 0); // drop a leftover token
        s.write_status = USB_TRANSFER_STATUS_ERROR;
        if (s.has_out) {
            memcpy(s.out->data_buffer, report, DSP_REPORT_SIZE);
            s.out->bEndpointAddress = s.ep_out;
            s.out->num_bytes = DSP_REPORT_SIZE;
            s.out->flags = 0;
            s.out_pending = true;
            result = usb_host_transfer_submit(s.out);
        } else {
            usb_setup_packet_t *setup = (usb_setup_packet_t *)s.out->data_buffer;
            setup->bmRequestType = USB_BM_REQUEST_TYPE_DIR_OUT | USB_BM_REQUEST_TYPE_TYPE_CLASS | USB_BM_REQUEST_TYPE_RECIP_INTERFACE;
            setup->bRequest = HID_SET_REPORT;
            setup->wValue = (HID_REPORT_TYPE_OUTPUT << 8) | 0;
            setup->wIndex = s.interface_number;
            setup->wLength = DSP_REPORT_SIZE;
            memcpy(s.out->data_buffer + USB_SETUP_PACKET_SIZE, report, DSP_REPORT_SIZE);
            s.out->bEndpointAddress = 0;
            s.out->num_bytes = USB_SETUP_PACKET_SIZE + DSP_REPORT_SIZE;
            s.out_pending = true;
            result = usb_host_transfer_submit_control(s.client, s.out);
        }
        if (result != ESP_OK) {
            s.out_pending = false;
        } else if (xSemaphoreTake(s.write_done, pdMS_TO_TICKS(WRITE_TIMEOUT_MS)) != pdTRUE) {
            // The transfer is still owned by the stack: cancel it and wait for its callback.
            if (s.has_out) {
                usb_host_endpoint_halt(s.dev, s.ep_out);
                usb_host_endpoint_flush(s.dev, s.ep_out);
                usb_host_endpoint_clear(s.dev, s.ep_out);
            }
            xSemaphoreTake(s.write_done, pdMS_TO_TICKS(WRITE_TIMEOUT_MS));
            result = ESP_ERR_TIMEOUT;
        } else {
            result = s.write_status == USB_TRANSFER_STATUS_COMPLETED ? ESP_OK : ESP_FAIL;
            if (s.write_status == USB_TRANSFER_STATUS_STALL && s.has_out) {
                usb_host_endpoint_clear(s.dev, s.ep_out);
            }
        }
    }
    if (result == ESP_OK) {
        s.stats.reports_out++;
    } else {
        s.stats.out_errors++;
    }
    xSemaphoreGive(s.write_lock);
    return result;
}

void dsp_usb_get_stats(dsp_usb_stats_t *out)
{
    *out = s.stats;
}
