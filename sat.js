// 0. Network & Performance Overrides
Cesium.RequestScheduler.requestsByServer = 12; // De 6 (natiu) a 12! Doblem el múscul de descàrrega paral·lela.

// 1. Visor Engine
const viewer = new Cesium.Viewer('cesiumContainer', {
    imageryProvider: false,
    baseLayerPicker: false, geocoder: false, homeButton: false,
    infoBox: false, navigationHelpButton: false, sceneModePicker: false,
    timeline: false, animation: false, fullscreenButton: false,
    selectionIndicator: false, // Fora el quadrat verd de 'diables'!
    skyAtmosphere: false, backgroundColor: Cesium.Color.BLACK,
});

viewer.scene.globe.baseColor = Cesium.Color.BLACK;
viewer.scene.globe.tileCacheSize = 3000; // Guardem 3000 mosaics a la RAM (en lloc de 100) per agilitzar l'animació.
viewer.scene.sun.show = false;
viewer.scene.moon.show = false;
viewer.scene.skyBox.show = false;

// Afegim el fons base satèl·lital d'ESRI mitjançant XYZ Tiles
// Així esquivem els bugs de la classe ArcGisMapServer de Cesium 1.108
viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19
}));

// 2. State
let layers = [];
let timeStamps = [];
let currentIdx = 0;
let isPlaying = true;
let animSpeed = 800;
let activeLayerID = "mtg_fd:rgb_geocolour";
let historyHours = 3;
let currentBrightness = 1.2;

// --- LOGICA DE COLORS WINDY ORIGINAL PORTADA A 3D ---
const colorStopsDbz = [
    { dbz: 0, color: [0, 0, 0], alpha: 0 },
    { dbz: 14, color: [173, 216, 230], alpha: 255 }, { dbz: 17, color: [135, 206, 250], alpha: 255 },
    { dbz: 20, color: [100, 149, 237], alpha: 255 }, { dbz: 23, color: [65, 105, 225], alpha: 255 },
    { dbz: 26, color: [0, 191, 255], alpha: 255 }, { dbz: 29, color: [0, 255, 255], alpha: 255 },
    { dbz: 32, color: [60, 179, 113], alpha: 255 }, { dbz: 35, color: [50, 205, 50], alpha: 255 },
    { dbz: 38, color: [173, 255, 47], alpha: 255 }, { dbz: 41, color: [255, 255, 0], alpha: 255 },
    { dbz: 44, color: [255, 215, 0], alpha: 255 }, { dbz: 47, color: [255, 165, 0], alpha: 255 },
    { dbz: 50, color: [255, 140, 0], alpha: 255 }, { dbz: 53, color: [255, 69, 0], alpha: 255 },
    { dbz: 56, color: [255, 0, 0], alpha: 255 }, { dbz: 59, color: [220, 20, 60], alpha: 255 },
    { dbz: 62, color: [199, 21, 133], alpha: 255 }, { dbz: 65, color: [218, 112, 214], alpha: 255 },
    { dbz: 68, color: [148, 0, 211], alpha: 255 }, { dbz: 71, color: [255, 255, 255], alpha: 255 }
];

function getColorForWindyValue(pixelValue) {
    const dbz = (pixelValue / 255) * 127.5;
    if (dbz < 14) return [0, 0, 0, 0];
    let lowerStop = colorStopsDbz[0];
    let upperStop = colorStopsDbz[colorStopsDbz.length - 1];
    for (let i = 0; i < colorStopsDbz.length - 1; i++) {
        if (dbz >= colorStopsDbz[i].dbz && dbz <= colorStopsDbz[i + 1].dbz) {
            lowerStop = colorStopsDbz[i];
            upperStop = colorStopsDbz[i + 1];
            break;
        }
    }
    if (dbz > upperStop.dbz) return [upperStop.color[0], upperStop.color[1], upperStop.color[2], upperStop.alpha];

    const range = upperStop.dbz - lowerStop.dbz;
    const position = (range === 0) ? 1 : (dbz - lowerStop.dbz) / range;
    const r = Math.round(lowerStop.color[0] * (1 - position) + upperStop.color[0] * position);
    const g = Math.round(lowerStop.color[1] * (1 - position) + upperStop.color[1] * position);
    const b = Math.round(lowerStop.color[2] * (1 - position) + upperStop.color[2] * position);
    const a = Math.round(lowerStop.alpha * (1 - position) + upperStop.alpha * position);
    return [r, g, b, a];
}
// -------------------------------------------------

// 3. Time Grid Logic
function buildTimeline() {
    timeStamps = [];
    const now = new Date();
    const samples = historyHours * 6; // FCI captures every 10 min

    // EUMETSAT Public Lag is ~45-55 mins
    let refTime = new Date(now.getTime() - (55 * 60000));

    for (let i = samples - 1; i >= 0; i--) {
        const t = new Date(refTime.getTime() - (i * 10 * 60000));
        t.setMinutes(Math.floor(t.getMinutes() / 10) * 10);
        t.setSeconds(0); t.setMilliseconds(0);
        timeStamps.push(t.toISOString().split('.')[0] + 'Z');
    }

    const slider = document.getElementById('time-slider');
    slider.max = timeStamps.length - 1;
    slider.value = timeStamps.length - 1;
    currentIdx = timeStamps.length - 1;
}

// 4. Layer Orchestrator (Mode Silenciós de Fons)
async function syncMissionData(isBackground = false) {
    if (!isBackground) {
        const loader = document.getElementById('loading-screen');
        loader.style.display = 'flex';
        loader.style.opacity = '1';
    }

    // Guardem on erem per no espantar l'usuari si actualitzem d'amagat
    let oldCurrentStamp = timeStamps[currentIdx];

    // Cleanup profund de capes (tant si són individuals com arrays de fotogrames)
    layers.forEach(group => {
        if (Array.isArray(group)) group.forEach(l => viewer.imageryLayers.remove(l));
        else viewer.imageryLayers.remove(group);
    });
    layers = [];

    // Check Type of layer to build Logic
    if (activeLayerID === 'radar_global') {
        let framesCount = historyHours * 6;
        let pastFrames = [];
        timeStamps = [];

        // Mètode Generador Temporal Síncron! Evitem buscar Hash. Windy utilitza Data-Hora lliure! (marge 15m)
        const now = new Date();
        const endRealTime = new Date(now.getTime() - 15 * 60000);
        endRealTime.setMinutes(Math.floor(endRealTime.getMinutes() / 10) * 10);
        endRealTime.setSeconds(0);

        for (let k = framesCount - 1; k >= 0; k--) {
            const t = new Date(endRealTime.getTime() - (k * 10 * 60000));
            timeStamps.push(t.toISOString().split('.')[0] + 'Z');
            pastFrames.push(t);
        }

        // Afegeix el Mapa Base Mundial Satèl·lit amb inicialització "fromUrl" obligatòria a Cesium actual (Evita GetDerivedResource undefined error!!)
        let bgProvider;
        try {
            bgProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer', {
                enablePickFeatures: false
            });
        } catch (e) {
            console.error("No es pot carregar el mapa base d'ESRI:", e);
        }

        if (bgProvider) {
            const bgLayer = viewer.imageryLayers.addImageryProvider(bgProvider);
            bgLayer.show = true;
            layers.push([bgLayer]); // Sempre en format array per ser consistent amb l'animador
        }

        pastFrames.forEach((d, i) => {
            if (!isBackground) document.getElementById('loading-txt').innerText = `SYNCING RADAR ${i + 1}/${pastFrames.length}`;

            let yyyy = d.getUTCFullYear();
            let mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            let dd = String(d.getUTCDate()).padStart(2, '0');
            let hh = String(d.getUTCHours()).padStart(2, '0');
            let min = String(d.getUTCMinutes()).padStart(2, '0');

            // Format Oficial URL de Windy (Lliure d'emcriptació / Hash)
            const provider = new Cesium.UrlTemplateImageryProvider({
                url: `https://rdr.windy.com/radar2/composite/${yyyy}/${mm}/${dd}/${hh}${min}/{z}/{x}/{y}/reflectivity.webp`,
                minimumLevel: 1,
                maximumLevel: 7
            });

            // L'enllaç original fallava per culpa de la pre-multiplicació d'Alpha i les Dimensions del format intern Bitmap de Cesium1.108+. Ho fem asíncronament a mà tal com en Leaflet!
            provider.requestImage = function (x, y, level, request) {
                // Deneguem els zoom fora de la resolució per evitar 404 oceànics
                if (level < 4) return undefined;

                return new Promise((resolve) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 256;
                    canvas.height = 256;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.imageSmoothingEnabled = false;

                    const img = new Image();
                    img.crossOrigin = "Anonymous";
                    // Reproduim l'adreça manualment per enganyar el sistema
                    img.src = `https://rdr.windy.com/radar2/composite/${yyyy}/${mm}/${dd}/${hh}${min}/${level}/${x}/${y}/reflectivity.webp`;

                    img.onload = () => {
                        // Obliguem a constrènyer als 256 píxels natius del globus si Windy serveix pedaços dobles
                        ctx.drawImage(img, 0, 0, 256, 256);

                        const imgData = ctx.getImageData(0, 0, 256, 256);
                        const data = imgData.data;

                        // Traduïm la Raw Data Roja al teu Espectre Clínic dBZ Suavitzat
                        for (let p = 0; p < data.length; p += 4) {
                            const newColor = getColorForWindyValue(data[p]);
                            data[p] = newColor[0];
                            data[p + 1] = newColor[1];
                            data[p + 2] = newColor[2];
                            data[p + 3] = newColor[3];
                        }
                        ctx.putImageData(imgData, 0, 0);

                        resolve(canvas);
                    };

                    img.onerror = () => {
                        // Deixa el canvas en buit i transparent a fons
                        resolve(canvas);
                    };
                });
            };

            const layer = viewer.imageryLayers.addImageryProvider(provider);
            layer.show = true;
            layer._defaultAlpha = 0.90; // Propietat personal per recordar l'opacitat de visualització final
            layer.alpha = (i === pastFrames.length - 1) ? layer._defaultAlpha : 0.0;

            // Format array de capes (pot incloure una soleta o múltiples)
            layers.push([layer]);
        });

    } else {
        // EUMETSAT SATELLITE TILE BUILDER (o Mixte amb Radar!)
        buildTimeline();
        const [layerName, styleName] = activeLayerID.split('|');
        const showOverlayRadar = document.getElementById('radar-overlay').checked;

        timeStamps.forEach((ts, i) => {
            if (!isBackground) {
                document.getElementById('loading-txt').innerText = `SYNCING FRAME ${i + 1}/${timeStamps.length}`;
            }

            let frameLayers = [];

            // -1) SATELLITE (Base EUMETSAT)
            const providerSat = new Cesium.WebMapServiceImageryProvider({
                url: 'https://view.eumetsat.int/geoserver/ows',
                layers: layerName,
                tileWidth: 512,  // Doblem la mida del mosaic per demanar 4 cops menys fitxers però més nítids!
                tileHeight: 512,
                parameters: {
                    service: 'WMS',
                    version: '1.3.0',
                    transparent: 'true',
                    format: 'image/png',
                    time: ts,
                    styles: styleName || ''
                }
            });

            // Renderització Satel·lit sense artificialitats directes, però amb brillantor dinàmica segons la càmera
            const layerSat = viewer.imageryLayers.addImageryProvider(providerSat);
            layerSat.show = true;
            layerSat.brightness = currentBrightness;
            layerSat._defaultAlpha = 0.90;
            layerSat.alpha = (i === timeStamps.length - 1) ? layerSat._defaultAlpha : 0.0;
            frameLayers.push(layerSat);

            // -2) RADAR SIMULTANI (Windy superposat)
            if (showOverlayRadar) {
                // Necessitem que l'hora "escatxarrada" d'EUMETSAT s'arrodoneixi netament als 10min absoluts (13:14h -> 13:10h)
                let d = new Date(ts);
                d.setMinutes(Math.floor(d.getMinutes() / 10) * 10);

                let yyyy = d.getUTCFullYear();
                let mm = String(d.getUTCMonth() + 1).padStart(2, '0');
                let dd = String(d.getUTCDate()).padStart(2, '0');
                let hh = String(d.getUTCHours()).padStart(2, '0');
                let min = String(d.getUTCMinutes()).padStart(2, '0');

                const providerRadar = new Cesium.UrlTemplateImageryProvider({
                    url: `https://rdr.windy.com/radar2/composite/${yyyy}/${mm}/${dd}/${hh}${min}/{z}/{x}/{y}/reflectivity.webp`,
                    minimumLevel: 1, maximumLevel: 7
                });

                providerRadar.requestImage = function (x, y, level, request) {
                    if (level < 4) return undefined;
                    return new Promise((resolve) => {
                        const canvas = document.createElement('canvas');
                        canvas.width = 256; canvas.height = 256;
                        const ctx = canvas.getContext('2d', { willReadFrequently: true });
                        ctx.imageSmoothingEnabled = false;

                        const img = new Image();
                        img.crossOrigin = "Anonymous";
                        img.src = `https://rdr.windy.com/radar2/composite/${yyyy}/${mm}/${dd}/${hh}${min}/${level}/${x}/${y}/reflectivity.webp`;

                        img.onload = () => {
                            ctx.drawImage(img, 0, 0, 256, 256);
                            const imgData = ctx.getImageData(0, 0, 256, 256);
                            const data = imgData.data;

                            for (let p = 0; p < data.length; p += 4) {
                                const newColor = getColorForWindyValue(data[p]);
                                data[p] = newColor[0]; data[p + 1] = newColor[1]; data[p + 2] = newColor[2]; data[p + 3] = newColor[3];
                            }
                            ctx.putImageData(imgData, 0, 0);
                            resolve(canvas);
                        };
                        img.onerror = () => resolve(canvas);
                    });
                };

                const layerRadar = viewer.imageryLayers.addImageryProvider(providerRadar);
                layerRadar.show = true;
                layerRadar._defaultAlpha = 0.55; // Fet "un pèl més transparent" per fondre's genial amb els núvols del davall!
                layerRadar.alpha = (i === timeStamps.length - 1) ? layerRadar._defaultAlpha : 0.0;
                frameLayers.push(layerRadar);
            }

            layers.push(frameLayers);
        });
    }

    if (!isBackground) {
        setTimeout(() => {
            const ldr = document.getElementById('loading-screen');
            ldr.style.opacity = '0';
            setTimeout(() => ldr.style.display = 'none', 800);
        }, 1000);
    }

    // Quan acaba de re-baixar per fons sense molestar:
    if (isBackground && isPlaying) {
        // Si està reproduïnt, va a l'últim (nou arribat) netament!
        switchFrame(timeStamps.length - 1);
    } else if (isBackground && !isPlaying) {
        // Si estem rebuscant al slider, ens manté al moment que escrutàvem original
        let newIdx = timeStamps.indexOf(oldCurrentStamp);
        switchFrame(newIdx !== -1 ? newIdx : timeStamps.length - 1);
    } else {
        updateReadout(currentIdx);
    }
}

function switchFrame(index) {
    if (!layers[index]) return;

    // Atomic alpha switch
    // El 90% lliga l'opacitat deixant entreveure el mapa
    layers[index].forEach(l => l.alpha = l._defaultAlpha);
    layers.forEach((frameGroup, i) => {
        if (i !== index) frameGroup.forEach(l => l.alpha = 0.0);
    });

    currentIdx = index;
    updateReadout(index);
}

function updateReadout(index) {
    const date = new Date(timeStamps[index]);
    document.getElementById('time-val').innerText = date.toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    document.getElementById('date-val').innerText = date.toLocaleDateString('ca-ES', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
    document.getElementById('time-slider').value = index;
}

// 5. App Loop (Motor pur d'esprints sense fantasmagoria i fre d'última capa)
let lastFrameTime = 0;
let currentFrame = 0;
function loop() {
    if (!isPlaying || timeStamps.length === 0 || layers.length === 0) {
        requestAnimationFrame(loop);
        return;
    }

    const now = Date.now();
    const elapsed = now - lastFrameTime;

    // Augmentem brutalment a 3 vegades la durada a l'arribar al últim clip com a Pausa Dramàtica
    const effectiveSpeed = (currentFrame === timeStamps.length - 1) ? animSpeed * 3.0 : animSpeed;

    if (elapsed > effectiveSpeed) {
        currentFrame++;
        if (currentFrame >= timeStamps.length) currentFrame = 0;

        layers.forEach((frameGroup, i) => {
            frameGroup.forEach(l => {
                l.alpha = (i === currentFrame) ? l._defaultAlpha : 0.0;
            });
        });

        const currentTS = timeStamps[currentFrame];
        const tsDate = new Date(currentTS);

        document.getElementById('time-val').innerText =
            `${String(tsDate.getUTCHours()).padStart(2, '0')}:${String(tsDate.getUTCMinutes()).padStart(2, '0')}`;
        document.getElementById('date-val').innerText = tsDate.toLocaleDateString('ca-ES', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
        document.getElementById('time-slider').value = currentFrame;

        lastFrameTime = now;
    }

    requestAnimationFrame(loop);
}

// 6. HUD Listeners
const playBtn = document.getElementById('play-btn');
playBtn.onclick = () => {
    isPlaying = !isPlaying;
    if (isPlaying) { lastFrameTime = 0; } // Reseteja el rellotge de transició
    const icon = document.getElementById('play-icon');
    icon.innerHTML = isPlaying ?
        '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' :
        '<path d="M8 5v14l11-7z"/>';
};

document.getElementById('time-slider').oninput = (e) => {
    isPlaying = false;
    const icon = document.getElementById('play-icon');
    icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
    switchFrame(parseInt(e.target.value));
};

document.getElementById('hour-slider').onchange = (e) => {
    historyHours = parseInt(e.target.value);
    syncMissionData();
};

document.getElementById('hour-slider').oninput = (e) => {
    document.getElementById('hour-val').innerText = e.target.value + "h";
};

document.getElementById('speed-slider').oninput = (e) => {
    animSpeed = parseInt(e.target.value);
    document.getElementById('speed-val').innerText = (animSpeed / 1000).toFixed(2) + "s";
};

document.getElementById('layer-select').addEventListener('change', () => {
    activeLayerID = document.getElementById('layer-select').value;
    syncMissionData();
});
document.getElementById('radar-overlay').addEventListener('change', () => {
    syncMissionData();
});

// 7. Borders Overlay
let bordersLayer = null;
function updateBorders() {
    const show = document.getElementById('borders-toggle').checked;
    if (show && !bordersLayer) {
        const provider = new Cesium.WebMapServiceImageryProvider({
            url: 'https://view.eumetsat.int/geoserver/ows',
            layers: 'backgrounds:ne_boundary_lines_land,backgrounds:ne_10m_coastline',
            parameters: {
                service: 'WMS',
                version: '1.3.0',
                transparent: 'true',
                format: 'image/png'
            }
        });
        bordersLayer = viewer.imageryLayers.addImageryProvider(provider);
        bordersLayer.alpha = 0.6;
    } else if (!show && bordersLayer) {
        viewer.imageryLayers.remove(bordersLayer);
        bordersLayer = null;
    }
}

document.getElementById('borders-toggle').onchange = updateBorders;
updateBorders();

// 7.5 Resolution Override (Força LOD / Nivel de Detall Profund)
document.getElementById('hd-toggle').onchange = (e) => {
    if (e.target.checked) {
        // Mode 4K Equilibrat: Menys agressiu que abans per no col·lapsar de tiles, però molt nítid.
        viewer.scene.globe.maximumScreenSpaceError = 0.85; 
    } else {
        // Mode Estàndard Millorat: Una mica millor que el natiu 2.0 per que no es vegi borrós de lluny.
        viewer.scene.globe.maximumScreenSpaceError = 1.6;

        // Com que Cesium guarda la versió bona a l'ordinador, provoquem una escombrada (cache drop)
        // en cas que el zoom estigui baix creant un microsalt a la càmara per esbrinar les de baixa densitat.
        layers.forEach((frameGroup) => frameGroup.forEach(l => viewer.imageryLayers.remove(l, false)));
        layers.forEach((frameGroup) => frameGroup.forEach(l => viewer.imageryLayers.add(l)));
    }
};

// 8. Navigation Shortcuts
function goTo(region) {
    let dest;
    switch (region) {
        case 'FD': dest = Cesium.Cartesian3.fromDegrees(0, 0, 18000000); break;
        case 'EU': dest = Cesium.Cartesian3.fromDegrees(15, 48, 6000000); break;
        case 'CAT': dest = Cesium.Cartesian3.fromDegrees(2, 41.5, 600000); break;
        case 'AF': dest = Cesium.Cartesian3.fromDegrees(18, 0, 10000000); break;
    }
    viewer.camera.flyTo({
        destination: dest,
        duration: 2
    });
}
window.goTo = goTo;

// 9. Menu Toggle
const menuToggle = document.getElementById('menu-toggle');
const controlPanel = document.getElementById('control-panel');
menuToggle.onclick = () => {
    controlPanel.classList.toggle('hidden');
};

// 10. Initial Launch
syncMissionData();
requestAnimationFrame(loop);

viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(15, 30, 15000000)
});

// 11. HUD Info Òptim (Lector de Mosaics)
const tileStatus = document.getElementById('tile-status');
const tileCount = document.getElementById('tile-count');

viewer.scene.globe.tileLoadProgressEvent.addEventListener((numPending) => {
    if (numPending > 0) {
        tileStatus.classList.remove('hidden');
        tileCount.innerText = numPending;
    } else {
        tileStatus.classList.add('hidden');
    }
});

// 12. Auto-Actualitzador Silenciós (Daemon Temporal Universal)
// En línies de producció meteorològiques no confiem en deduir l'hora, simplement ens posem en llista al cron global per fer la neteja quan fa minuts llargs.
setInterval(() => {
    console.log("Executant actualització general de seguretat...");
    syncMissionData(true);
}, 300000); // Executa l'update asincron cada 5 minuts (300.000 ms) pel Radar o Satèl·lit.

// 13. Brilliantor Dinàmica segons Zoom (Experiència Immersiva)
viewer.camera.changed.addEventListener(() => {
    const height = viewer.camera.positionCartographic.height;
    
    // De 1.0 (Terra completa) a 1.20 (Ciutat de prop) - Res exagerat com demanes!
    let t = Math.min(Math.max(1.0 - (height / 15000000), 0), 1);
    currentBrightness = 1.0 + (t * 0.20); 

    // Actualitzem les capes actives immediatament per evitar salts bruscs
    layers.forEach(frameGroup => {
        if (Array.isArray(frameGroup)) {
            frameGroup.forEach(l => {
                if (l.imageryProvider instanceof Cesium.WebMapServiceImageryProvider) {
                    l.brightness = currentBrightness;
                }
            });
        }
    });
});
