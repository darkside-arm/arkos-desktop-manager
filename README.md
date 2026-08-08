# ArkOS Desktop Manager

**ArkOS Desktop Manager** (interno: **R36S Manager**) — aplicación de escritorio estilo macOS para gestionar una consola portátil R36S con ArkOS, mediante SSH.

## Características

- **Conexión SSH** a la consola (usuario/contraseña o clave), con estado en tiempo real.
- **Exploración de sistemas y juegos** leyendo los `gamelist.xml` de ArkOS/EmulationStation.
- **Favoritos**: marcar/desmarcar juegos como favoritos directamente en el gamelist remoto.
- **Lanzamiento remoto** de juegos y **reinicio de EmulationStation**.
- **Scraper de metadatos**: búsqueda de carátulas, capturas y vídeo desde ScreenScraper (con Google Images / Bing como respaldo), con edición manual antes de confirmar.
- **Colecciones**: crear listas personalizadas de ROMs y enviarlas a la consola.
- **Caché local** de gamelists y medios (imágenes/vídeo) por host, en `~/.config/r36s-manager/`.
- **Tema claro/oscuro** y barra de título personalizada (controles nativos en macOS).

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior
- [npm](https://www.npmjs.com/)

## Instalación

```bash
npm install
```

## Uso

```bash
npm start
```

Para desarrollo con inspección:

```bash
npm run dev
```

## Configuración

La configuración y las cachés se guardan en el directorio `~/.config/r36s-manager/`:

```
~/.config/r36s-manager/
├── settings.json      # ajustes guardados
├── cache/             # gamelists cacheados por host
└── media-cache/       # imágenes y vídeo cacheados
```

La conexión SSH usa la dirección IP, usuario y contraseña de la consola (el usuario típico en ArkOS es `root`).

## Compilación

```bash
npm run build
```

Genera los instaladores para macOS (DMG) y Windows (NSIS) mediante `electron-builder`.

## Estructura

```
src/
├── main/          # proceso principal de Electron
│   ├── main.js    # SSH, scraper, IPC, cachés
│   └── preload.js # puente seguro contextBridge
└── renderer/      # interfaz (HTML/CSS/JS)
    ├── index.html
    ├── styles.css
    ├── renderer.js
    └── collection-engine.js
```

## Tecnologías

- [Electron](https://www.electronjs.org/) 28
- [node-ssh](https://www.npmjs.com/package/node-ssh)
- [xml2js](https://www.npmjs.com/package/xml2js)
