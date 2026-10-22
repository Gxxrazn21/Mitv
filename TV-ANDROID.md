# MiTV en Fire TV y Android

La navegación con control remoto se ejecuta en el frontend (`tv.js`). No necesita una API de teclas ni cambios en Express. Servir los archivos actualizados de `public/`, incluidos `tv.js` y `tv.css`.

## Probar localmente

```powershell
npm start
# Abrir http://localhost:7860/?tv=1
node --test tests/tv-player.test.js
```

`?tv=1` fuerza TV; `?tv=0` permite probar el diseño normal. La detección automática reconoce Fire TV (AFT) y agentes de usuario habituales de TV. Un WebView con agente genérico debe cargar explícitamente `?tv=1` en televisores. No se usa el ancho de pantalla para distinguir un televisor de un teléfono.

- Flechas: navegación espacial y desplazamiento del contenido enfocado.
- OK/Enter: activar botón/canal; en una ranura, activar audio y entrar a sus controles.
- Espacio: activar el control enfocado; fuera de controles, reproducir/pausar.
- Atrás/Escape: cerrar el diálogo o salir de los controles de la ranura.
- Volumen: izquierda/derecha sobre el deslizador; arriba/abajo para salir.
- Tab y Shift+Tab: navegación habitual, contenida en el diálogo cuando está abierto.

TV reserva 5 % por borde. Los listados y barras de herramientas conservan desplazamiento interno: no se ocultan controles para evitar scroll. La página no tiene scroll global. Android/TV desactiva nitidez SVG, normalizador Web Audio y efectos costosos; mantiene calidad adaptativa con búfer reducido. Al pasar de cuatro pantallas a dos o una, se cierran las ranuras ocultas para liberar red, memoria y decodificadores.

## Contenedor APK

Este repositorio no contiene un proyecto Android/Gradle: no se ha generado un APK. En el proyecto del contenedor:

1. Declarar permiso `android.permission.INTERNET` y `android:hardwareAccelerated="true"` en la aplicación/actividad. No usar `LAYER_TYPE_SOFTWARE` para WebView ni sus padres.
2. Habilitar `webView.settings.javaScriptEnabled = true`, `domStorageEnabled = true` y, si se desea inicio automático, `mediaPlaybackRequiresUserGesture = false`. Mantener WebView actualizado.
3. Cargar la URL HTTPS de Oracle. Para TV, agregar `?tv=1`; para celulares, omitirlo. Usar `WebViewClient` y `WebChromeClient`; implementar `onShowCustomView`/`onHideCustomView` si se requiere pantalla completa nativa.
4. Permitir que WebView reciba foco y entregue D-pad/Enter a la página. El botón nativo Atrás debe cerrar primero el teclado, salir de pantalla completa o enviar `Escape` a la página cuando haya un diálogo/controles activos; de otro modo aplicar la navegación/salida normal de la actividad. No interceptar todas las teclas indiscriminadamente.
5. Para aparecer en el launcher de TV, configurar `LEANBACK_LAUNCHER`, banner y `android.hardware.touchscreen` con `required="false"`. Mantener también el launcher móvil si el mismo APK sirve ambos dispositivos.
6. Compilar en Android Studio o con `gradlew.bat assembleDebug` **dentro del proyecto Android**. Para distribución, generar y firmar el APK release con la clave propia del proyecto.

`translateZ(0)` favorece composición; no garantiza decodificación por hardware ni soporte de códecs/DRM. Si un contenedor sigue mostrando negro con un flujo válido, comprobar WebView, aceleración, códec y número de decodificadores simultáneos. Cuatro streams HD pueden superar la capacidad de un Fire TV básico.

## Recuperación y límites

Resolución: 20 s. Inicio HLS: 25 s. Bloqueo durante reproducción: 20 s. Se conservan dos reintentos de red y se limitan a dos las recuperaciones de decodificador, pasando después a la siguiente opción. No se vuelve automáticamente a opciones anteriores. Los errores finales liberan medios y ofrecen reintento manual. Si el navegador bloquea autoplay, se solicita Reanudar en vez de cambiar de fuente.

En embeds se limita a 25 s la carga del documento. El evento `load` **no demuestra reproducción**: un iframe de otro origen puede cargar y quedarse negro; sin una API cooperativa del proveedor no se puede verificar su video ni garantizar D-pad dentro de él. La navegación implementada cubre la interfaz MiTV; los controles del proveedor pueden requerir integración propia. Para integración nativa completa, evaluar un reproductor Android compatible con los flujos/DRM utilizados.

## Validación

Pruebas automatizadas con Node: geometría direccional, timeout y limpieza, fallback nativo sin HLS.js, recuperación limitada y autoplay con protección frente a respuestas antiguas. No sustituyen pruebas de reproducción real en hardware.

Antes de distribuir: comprobar 720p, 1080p y 4K, móvil vertical/horizontal, lista larga, diálogo y retorno de foco; probar 1/2/4 pantallas, pausa prolongada, desconexión, cambio rápido de canal y cierre de ranuras. La revisión visual automatizada no estuvo disponible en esta sesión (navegador integrado no disponible). No se ha desplegado este cambio en Oracle.

Referencias: [diseño Fire TV y margen seguro](https://www.developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html), [WebSettings de Android](https://developer.android.com/reference/android/webkit/WebSettings), [aceleración de WebView](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/software_draw_deprecated.md).
