import type { DeprecationOrId } from "sass";

/** Bootstrap 5.3 e o ArchitectUI usam @import e funções globais do Sass 1.x: avisos silenciados (ainda aceitos). */
export const SASS_SILENCED: DeprecationOrId[] = ["import", "global-builtin", "color-functions", "if-function"];
