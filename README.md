---
title: Mitv
emoji: 📺
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
---

# 🛡️ Pirlo Shield — Capo Deportes & Deportes En Vivo (Sin Anuncios)

Una aplicación web moderna, ultra-fluida y 100% segura diseñada para disfrutar transmisiones deportivas en vivo (Champions League, Premier League, LaLiga, Capo Deportes, ESPN, DSPORTS, Win Sports, etc.) **eliminando por completo la publicidad invasiva, redirecciones, popunders y falsos instaladores**.

Desarrollada aplicando la metodología de **Replica** e ingeniería inversa de flujos de video (**REA - Reverse Engineer Anything**).

---

## 🚀 Características Principales

1. **🛡️ 100% Sin Publicidad ni Popups**:
   - Olvídate de los molestos clics falsos, pestañas publicitarias y redirecciones a páginas de apuestas.
   - Neutralización completa de redes de anuncios (`llvpn`, `greatdexchange`, `algazelatuami`, `aclib`, etc.).

2. **⚡ Doble Motor de Reproducción**:
   - **Motor HLS Nativo (Recomendado)**: Extrae directamente la lista de reproducción `.m3u8` desde los servidores CDN (`instreams.xyz`, `gate4.st`, `domhsd.com`) y la reproduce usando un reproductor HTML5 nativo con Hls.js acelerado por hardware a 60 FPS sin cargar nada del código web original.
   - **Motor Sanitized Clean-Embed Proxy**: Para streams protegidos por Clearkey DRM (Shaka Player) o Clappr, el servidor proxy limpia en tiempo real el DOM, elimina los scripts maliciosos, anula bloqueos por sandbox (evitando el error `dash_shaka_playback:4_4012` y trampas de detección anti-sandbox), y neutraliza popups y redirecciones forzadas sin alterar la clave de cifrado.

3. **⚽ Programación en Vivo en Tiempo Real**:
   - Sincronización automática de todos los partidos del día (Champions League, Premier League, LaLiga, etc.).
   - Múltiples opciones y servidores por evento (Opción 1, Opción 2 HD, Opción 3, etc.).
   - Filtros rápidos por torneo o búsqueda en tiempo real de equipos.

4. **📺 Canales 24/7 Disponibles**:
   - Capo Deportes 1 y 2
   - ESPN (1, 2, 3, 4, 5, Premium Argentina, Deportes USA)
   - DirecTV DSPORTS (DSPORTS, DSPORTS 2, DSPORTS +)
   - Win Sports y Win Sports + (FPC Colombia)
   - TNT Sports Premium (Argentina y Chile)
   - TUDN, Liga 1 Max, Telemundo USA, Universo USA, Fórmula 1.

5. **🎮 Controles Avanzados & Atajos**:
   - **Espacio**: Reproducir / Pausar
   - **F**: Pantalla Completa
   - **T**: Modo Cine / Teatro
   - **M**: Silenciar / Activar Sonido
   - **PiP**: Picture in Picture (pantalla flotante para ver mientras trabajas)
   - Botón de **Reconexión Inmediata** en 1 clic.

---

## 🛠️ Instalación y Uso Local

### 1. Iniciar el Servidor

Abre tu terminal en esta carpeta (`d:\Proyectos_Trae\prueba`) y ejecuta:

```bash
npm start
```

### 2. Abrir en tu Navegador

Entra a:

```
http://localhost:7860
```

¡Y listo! Selecciona cualquier partido o canal y disfruta del deporte en vivo de forma instantánea y limpia.

---

## 🔒 Análisis de Seguridad y Prevención de Malware

Las páginas tradicionales de streaming gratuito utilizan múltiples capas de engaño para forzar instalaciones:
- **Descargas falsas**: Falsas alertas de *"Actualizar Flash Player"* o *"Extensión requerida"*.
- **Clickjacking**: Capas transparentes `<div>` con `z-index: 99999` para que el primer clic en la pantalla abra un popunder.
- **Redirecciones automáticas**: Mediante scripts `location.href` cuando intentas poner pantalla completa.

**Cómo lo soluciona Pirlo Shield**:
1. El backend actúa como un **extractor seguro**: Descarga la página remota en el servidor, localiza la dirección pura del video `.m3u8` y descarta el 100% de los scripts publicitarios.
2. Tu navegador únicamente recibe datos de video (`video/mp2t` y `application/vnd.apple.mpegurl`).
3. La configuración de seguridad del navegador nunca ejecuta código de terceros sospechosos.
