# Translucence Liquid Glass
Adds physics-based glassmorphism and real-time refraction to Discord UI containers.

This plugin is designed to be applied alongside a translucent or transparent base theme. It is highly recommended and tested to pair perfectly with *Translucence by CapnKitten*. Compatibility with other themes may vary, as elements were tested specifically using Translucence.

---

## Performance Notice & Preset Setup
When you first load the plugin, you will be prompted to select a rendering tier. Choose based on your setup:

* *Lite* (Best for most): If you are unsure of your specs or are running a standard laptop/PC, choose **Lite**. This focuses refraction solely on core containers (Message bar, popouts, modals) and keeps your performance smooth.
* **Professional:** Only choose this if you have a top-tier GPU (Maybe CPU too) and want maximum refraction depth mapping.

---

## Features
* **Physics-Based Refraction:** Uses Snell's Law calculations to bend the background layer around UI borders.
* **Smart Performance Capping:** Leverages Intersection and Resize Observers to ensure only on-screen containers consume GPU rendering cycles.

---

It should be fine, and bugs could be minor, meaning they do almost no harm, but if there is a major bug, you should definitely report it.

---


If you want the best Refraction & Performance setup, you can simply copy this and rewrite the config.json with it.
```{
    "settings": {
        "settingsVersion": 4,
        "presetChosen": "Default",
        "enabled": true,
        "surface": "convex_circle",
        "sizeMode": "relative",
        "divisor": 3,
        "thicknessRel": 4,
        "bezelRel": 1,
        "thicknessPx": 60,
        "bezelPx": 14,
        "ior": 1.5,
        "refraction": 1,
        "maxDisplacement": 45,
        "quality": 0.5,
        "blur": 1,
        "saturation": 1.25,
        "brightness": 1.05,
        "specular": 0.8,
        "specularAngle": 60,
        "specularWidth": 1.5,
        "groups": {
            "modals": true,
            "popouts": true,
            "tooltips": true,
            "composer": true,
            "cards": true,
            "activity": true,
            "custom": true,
            "messages": true,
            "buttons": true,
            "settings": true,
            "panes": true
        },
        "customSelectors": "#app-mount button\n#app-mount input\n#app-mount input",
        "maxSurfaces": 200,
        "avoidNesting": true,
        "neutralizeAncestors": true,
        "largeThreshold": 2000,
        "largeDetail": "full",
        "largeQuality": 0.5,
        "profiles": {},
        "highlight": false,
        "debug": false
    }
}```
