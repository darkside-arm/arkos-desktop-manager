const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('r36s', {
  // SSH
  connect:          cfg        => ipcRenderer.invoke('ssh:connect', cfg),
  disconnect:       ()         => ipcRenderer.invoke('ssh:disconnect'),
  status:           ()         => ipcRenderer.invoke('ssh:status'),
  listSystems:      ()         => ipcRenderer.invoke('ssh:list-systems'),
  readGamelist:     sysPath    => ipcRenderer.invoke('ssh:read-gamelist', sysPath),
  fetchMedia:       remotePath => ipcRenderer.invoke('ssh:fetch-media', remotePath),
  writeCollection:  opts       => ipcRenderer.invoke('ssh:write-collection', opts),
  listCollections:  ()         => ipcRenderer.invoke('ssh:list-collections'),
  setFavorite:      opts       => ipcRenderer.invoke('ssh:set-favorite', opts),
  uploadRom:        opts       => ipcRenderer.invoke('ssh:upload-rom', opts),
  restartES:        ()         => ipcRenderer.invoke('ssh:restart-es'),
  launchGame:       opts       => ipcRenderer.invoke('ssh:launch-game', opts),

  // Caché de gamelists en disco
  cacheLoad:        host               => ipcRenderer.invoke('cache:load', host),
  cacheSave:        (host, sys, games) => ipcRenderer.invoke('cache:save', { host, systems: sys, games }),
  cacheInvalidate:  host               => ipcRenderer.invoke('cache:invalidate', host),
  cacheInfo:        host               => ipcRenderer.invoke('cache:info', host),

  // Settings (~/.config/r36s-manager/settings.json)
  settingsLoad:     ()    => ipcRenderer.invoke('settings:load'),
  settingsSave:     obj   => ipcRenderer.invoke('settings:save', obj),

  // Scraper (ScreenScraper.fr)
  scrapeGame:       opts  => ipcRenderer.invoke('scraper:scrape-game', opts),
  scrapeFetch:      opts  => ipcRenderer.invoke('scraper:fetch', opts),
  scrapeFetchGoogle: opts => ipcRenderer.invoke('scraper:fetch-google-images', opts),
  scrapeFetchGameInfo: opts => ipcRenderer.invoke('scraper:fetch-game-info', opts),
  scrapeCommit:     opts  => ipcRenderer.invoke('scraper:commit', opts),
  scrapeCancel:     opts  => ipcRenderer.invoke('scraper:cancel', opts),
  onScrapeProgress: cb    => ipcRenderer.on('scraper:progress', (_, v) => cb(v)),

  // App / window
  getDarkMode:      ()    => false,
  getPlatform:      ()    => process.platform,
  getConfigDir:     ()    => ipcRenderer.invoke('app:config-dir'),
  saveTempFile:     opts  => ipcRenderer.invoke('app:save-temp-file', opts).then(r => r.ok ? r.localPath : null),
  onThemeChange:    ()    => {},
  onRomUploadProgress: cb => ipcRenderer.on('rom-upload-progress', (_, v) => cb(v)),
  winMinimize:      ()    => ipcRenderer.send('win:minimize'),
  winMaximize:      ()    => ipcRenderer.send('win:maximize'),
  winClose:         ()    => ipcRenderer.send('win:close'),
});
