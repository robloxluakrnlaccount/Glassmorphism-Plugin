# Translucence Liquid Glass
Adds physics-based glassmorphism and real-time refraction to Discord UI containers.

This plugin is designed to be applied alongside a translucent or transparent base theme. It is highly recommended and tested to pair perfectly with *Translucence by CapnKitten*. Compatibility with other themes may vary, as elements were tested specifically using Translucence.

---

## Performance Notice & Preset Setup
When you first load the plugin, you will be prompted to select a rendering tier. Choose based on your setup:

* *Lite* (Best for most): If you are unsure of your specs or are running a standard laptop/PC, choose **Lite**. This focuses refraction solely on core containers (Message bar, popouts, modals) and keeps your performance smooth.
* **Professional:** Only choose this if you have a top-tier CPU (Maybe GPU too) and want maximum refraction depth mapping.

---

## Features
* **Physics-Based Refraction:** Uses Snell's Law calculations to bend the background layer around UI borders.
* **Smart Performance Capping:** Leverages Intersection and Resize Observers to ensure only on-screen containers consume GPU rendering cycles.
