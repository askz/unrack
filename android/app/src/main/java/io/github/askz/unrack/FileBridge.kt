package io.github.askz.unrack

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Toast

/**
 * Preset files for the WebView: `window.AndroidFiles.save(name, mimeType, text)` opens the
 * system "save as" dialog (Storage Access Framework), and [chromeClient] implements the
 * WebView file chooser so `<input type="file">` works for import. The hosting activity
 * forwards [onActivityResult].
 */
class FileBridge(private val activity: Activity) {
    companion object {
        private const val TAG = "FileBridge"
        private const val REQUEST_SAVE = 4201
        private const val REQUEST_OPEN = 4202
    }

    private var pendingText: String? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null

    @JavascriptInterface
    fun save(name: String, mimeType: String, text: String) {
        activity.runOnUiThread {
            pendingText = text
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeType)
                .putExtra(Intent.EXTRA_TITLE, name)
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, REQUEST_SAVE)
        }
    }

    val chromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = filePathCallback
            val intent = fileChooserParams.createIntent()
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*") // JSON has no reliable MIME type on Android; the web app validates the content
            @Suppress("DEPRECATION")
            activity.startActivityForResult(intent, REQUEST_OPEN)
            return true
        }
    }

    /** Returns true when the result belonged to this bridge. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        when (requestCode) {
            REQUEST_SAVE -> {
                val text = pendingText
                pendingText = null
                val uri = data?.data
                if (resultCode == Activity.RESULT_OK && uri != null && text != null) writeDocument(uri, text)
            }
            REQUEST_OPEN -> {
                val callback = pendingChooser
                pendingChooser = null
                callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            }
            else -> return false
        }
        return true
    }

    private fun writeDocument(uri: Uri, text: String) {
        val saved = try {
            activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray(Charsets.UTF_8)) } != null
        } catch (e: Exception) {
            Log.w(TAG, "saving $uri failed", e)
            false
        }
        Toast.makeText(activity, if (saved) "Preset file saved" else "Could not save the preset file", Toast.LENGTH_SHORT).show()
    }
}
