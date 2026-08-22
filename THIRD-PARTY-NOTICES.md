# Third-party notices

This repository combines the original Maia 3 application with third-party
code, assets, model files, and packaging software. Keep this file and the
`licenses/` directory with redistributed source and builds.

## Maia-3 inference code

**Project:** Maia-3 / Chessformer  
**License:** AGPL-3.0  
**Source:** https://github.com/CSSLab/maia3

The bundled JavaScript inference implementation is a port of Maia-3
components. The upstream Maia-3 repository is AGPL-3.0.

## Maia-3 5M model weights

**Model:** UofTCSSLab/Maia3-5M  
**Upstream:** https://huggingface.co/UofTCSSLab/Maia3-5M

This release includes a converted `.bin` representation of the upstream
`maia3-5m.pt` checkpoint. See:

    weights/NOTICE-maia3-5m.txt

The upstream model card currently says "see repo for code/weights license"
rather than giving a separate weight-only license on the model card. The
upstream Maia-3 repository is AGPL-3.0. This project makes no independent
relicensing claim for the underlying model weights. Keep the provenance
notice with the file and verify upstream terms if you redistribute the model
separately.

## Stockfish.js

**Project:** Stockfish.js  
**Version:** 18.0.8  
**License:** GPL-3.0  
**Source:** https://github.com/nmrugg/stockfish.js

Stockfish is used only for objective analysis. Maia-3 remains the playing
engine.

The full GPL text is included as:

    stockfish/Copying.txt
    licenses/stockfish/GPL-3.0.txt

## chess.js

**Project:** chess.js  
**Version represented by bundled source:** 1.4.0  
**Author:** Jeff Hlywa  
**License:** BSD-2-Clause  
**Source:** https://github.com/jhlywa/chess.js

License text:

    licenses/chess.js/BSD-2-Clause.txt

## Cburnett chess pieces

**Asset:** Cburnett chess piece set  
**Author:** Colin M. L. Burnett  
**License:** GPLv2+  
**Source/attribution:** https://github.com/lichess-org/lila

License text:

    licenses/cburnett/GPL-2.0.txt

## Capacitor

**Projects:** `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`  
**License:** MIT  
**Source:** https://github.com/ionic-team/capacitor

Capacitor runtime code is included in Android APKs built by this repository.

The MIT license notice is reproduced in:

    licenses/capacitor/MIT.txt

The transitive Android/Gradle dependency graph is generated during the build;
those dependencies retain their own upstream licenses.

## Original Maia 3 application code

Except where a file/component is covered by a different third-party license or
notice, the original application code and original modifications are licensed
under AGPL-3.0. See `LICENSE`.
