// Ordinary script loading works in WebViews without document.write intervention.
(function () {
  var client = document.createElement('script');
  var tv = typeof isTV !== 'undefined' && isTV;
  client.src = (tv ? 'app-tv.js' : 'app.js') + '?v=8.2';
  client.async = false;
  function failed(message) {
    if (window.mitvClientReady) return;
    var list = document.getElementById('matchesList');
    if (list) list.textContent = message + ' (MiTV 8.2).';
  }
  client.onerror = function () { failed('No se pudo descargar la aplicación. Comprueba la conexión y vuelve a abrirla'); };
  window.addEventListener('error', function (event) {
    if (event.filename && /app(?:-tv)?\.js/.test(event.filename)) {
      failed('No se pudo iniciar la aplicación en este navegador. Actualiza el componente WebView de la APK');
    }
  });
  var timer = setTimeout(function () { failed('La aplicación no ha iniciado. Comprueba la conexión o el navegador de la APK'); }, 15000);
  window.addEventListener('mitv-ready', function () { clearTimeout(timer); });
  document.head.appendChild(client);
}());
