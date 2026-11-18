package org.wellkind.corrector;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final int ELEGIR_ARCHIVO = 10;
    private static final String CARPETA = "Corrector de Poligonos";

    private WebView web;
    private ValueCallback<Uri[]> esperaArchivo;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        getWindow().setStatusBarColor(Color.parseColor("#1E4D3A"));

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);

        web.addJavascriptInterface(new Puente(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView vista, WebResourceRequest pedido) {
                Uri u = pedido.getUrl();
                String esquema = u.getScheme();
                if ("http".equals(esquema) || "https".equals(esquema)) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignorar) { }
                    return true;
                }
                return false;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView vista, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (esperaArchivo != null) esperaArchivo.onReceiveValue(null);
                esperaArchivo = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Elegir archivo"), ELEGIR_ARCHIVO);
                } catch (Exception e) {
                    esperaArchivo = null;
                    return false;
                }
                return true;
            }
        });

        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, Intent datos) {
        if (pedido == ELEGIR_ARCHIVO && esperaArchivo != null) {
            Uri[] elegidos = null;
            if (resultado == RESULT_OK && datos != null && datos.getData() != null) {
                elegidos = new Uri[]{datos.getData()};
            }
            esperaArchivo.onReceiveValue(elegidos);
            esperaArchivo = null;
            return;
        }
        super.onActivityResult(pedido, resultado, datos);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** Funciones que la página puede llamar como Android.guardarArchivo(...) */
    private class Puente {
        @JavascriptInterface
        public String guardarArchivo(String nombre, String base64, String mime) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, nombre);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + CARPETA);
                    Uri destino = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (destino == null) return "No se pudo crear el archivo en Descargas.";
                    try (OutputStream salida = getContentResolver().openOutputStream(destino)) {
                        salida.write(bytes);
                    }
                    return "Guardado en Descargas › " + CARPETA + " › " + nombre;
                } else {
                    File carpeta = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), CARPETA);
                    if (!carpeta.exists()) carpeta.mkdirs();
                    File archivo = new File(carpeta, nombre);
                    try (FileOutputStream salida = new FileOutputStream(archivo)) {
                        salida.write(bytes);
                    }
                    return "Guardado en " + archivo.getAbsolutePath();
                }
            } catch (Exception e) {
                return "No se pudo guardar: " + e.getMessage();
            }
        }
    }
}
