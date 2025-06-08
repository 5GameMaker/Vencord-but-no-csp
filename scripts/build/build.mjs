#!/usr/bin/node
/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// @ts-check

import { readdir } from "fs/promises";
import { join } from "path";

import { BUILD_TIMESTAMP, commonOpts, exists, globPlugins, IS_DEV, IS_REPORTER, IS_STANDALONE, IS_UPDATER_DISABLED, resolvePluginName, VERSION, commonRendererPlugins, watch, buildOrWatchAll, stringifyValues } from "./common.mjs";

const defines = stringifyValues({
    IS_STANDALONE,
    IS_DEV,
    IS_REPORTER,
    IS_UPDATER_DISABLED,
    IS_WEB: false,
    IS_EXTENSION: false,
    IS_USERSCRIPT: false,
    VERSION,
    BUILD_TIMESTAMP
});

if (defines.IS_STANDALONE === "false") {
    // If this is a local build (not standalone), optimize
    // for the specific platform we're on
    defines["process.platform"] = JSON.stringify(process.platform);
}

/**
 * @type {import("esbuild").BuildOptions}
 */
const nodeCommonOpts = {
    ...commonOpts,
    define: defines,
    format: "cjs",
    platform: "node",
    target: ["esnext"],
    // @ts-ignore this is never undefined
    external: ["electron", "original-fs", "~pluginNatives", ...commonOpts.external]
};

const sourceMapFooter = s => watch ? "" : `//# sourceMappingURL=vencord://${s}.js.map`;
const sourcemap = watch ? "inline" : "external";

/**
 * @type {import("esbuild").Plugin}
 */
const globNativesPlugin = {
    name: "glob-natives-plugin",
    setup: build => {
        const filter = /^~pluginNatives$/;
        build.onResolve({ filter }, args => {
            return {
                namespace: "import-natives",
                path: args.path
            };
        });

        build.onLoad({ filter, namespace: "import-natives" }, async () => {
            const pluginDirs = ["plugins", "userplugins"];
            let code = "";
            let natives = "\n";
            let i = 0;
            for (const dir of pluginDirs) {
                const dirPath = join("src", dir);
                if (!await exists(dirPath)) continue;
                const plugins = await readdir(dirPath, { withFileTypes: true });
                for (const file of plugins) {
                    const fileName = file.name;
                    const nativePath = join(dirPath, fileName, "native.ts");
                    const indexNativePath = join(dirPath, fileName, "native/index.ts");

                    if (!(await exists(nativePath)) && !(await exists(indexNativePath)))
                        continue;

                    const pluginName = await resolvePluginName(dirPath, file);

                    const mod = `p${i}`;
                    code += `import * as ${mod} from "./${dir}/${fileName}/native";\n`;
                    natives += `${JSON.stringify(pluginName)}:${mod},\n`;
                    i++;
                }
            }
            code += `export default {${natives}};`;
            async function loader() {
                // TODO: Handle plugin failures.
                // TODO: Use `import(..)` for .mjs.
                // @ts-ignore
                const { PLUGINS_DIR: dirPath } = require("./main/utils/constants");

                if (!await exists(dirPath)) return;
                const plugins = await readdir(dirPath, { withFileTypes: true });
                for (const file of plugins) {
                    const fileName = file.name;
                    const nativePath = join(dirPath, fileName, "native.js");
                    const indexNativePath = join(dirPath, fileName, "native/index.js");

                    if (!(await exists(nativePath)) && !(await exists(indexNativePath)))
                        continue;

                    try {
                        require(`${dirPath}/${fileName}/native`);
                    } catch (e) {
                        console.error(`Failure while loading plugin ${JSON.stringify(fileName)}`);
                        console.error(e);
                    }
                }
            }
            /* eslist-disable */
            function patchRequire() {
                const mod = require('module');
                // @ts-ignore
                if (mod.prototype.VENCORDNOCSP_CUSTOM_REQUIRE) return;
                const nativeRequire = mod.prototype.require;
                mod.prototype.require = function(path) {
                    // @ts-ignore
                    const { PLUGINS_DIR } = require("./main/utils/constants");
                    if (path.startsWith("@")) {
                        /** @type {{[key: string]: string}} */
                        const paths = {
                            "@main": "./main",
                            "@api": "./api",
                            "@components": "./components",
                            "@utils": "./utils",
                            "@shared": "./shared",
                            "@webpack/types": "./webpack/common/types",
                            "@webpack/patcher": "./webpack/patchWebpack",
                            "@webpack/common": "./webpack/common",
                            "@webpack/wreq.d": "./webpack/wreq.d",
                            "@webpack": "./webpack/webpack",
                            "@plugins": PLUGINS_DIR,
                        };
                        for (const key in paths) {
                            if (!path.startsWith(key)) continue;
                            let tryPath = path.slice(key.length);
                            if (tryPath.length && !tryPath.startsWith("/")) continue;
                            path = `${paths[key]}${tryPath}`;
                            break;
                        }
                        if (path.startsWith("@")) return nativeRequire.bind(this)(path);
                        // @ts-ignore
                        return requirePkgModule(path);
                    }
                    else return nativeRequire.bind(this)(path);
                };
                // @ts-ignore
                mod.prototype.VENCORDNOCSP_CUSTOM_REQUIRE = true;
            }
            /* eslist-enable */
            {
                let imports = "";
                imports += "if(IS_DISCORD_DESKTOP||IS_VESKTOP){";
                // The crimes we do.
                imports += "function requirePkgModule(path){";
                {
                    async function walk(path, prefix) {
                        const promises = [];
                        for (const file of await readdir(path, { withFileTypes: true })) {
                            const modp = join(path, file.name);
                            const modl = `${prefix}/${file.name}`;
                            if (file.isDirectory()) {
                                promises.push(walk(modp, modl));
                                continue;
                            }
                            const match = modl.match(/^((?:(?!\.d).)*)\.tsx?$/);
                            if (match) {
                                imports += `if(path=="${match[1]}")return require("${match[1]}");`;
                            }
                        }
                        await Promise.all(promises);
                    }
                    await walk("src", ".");
                }
                imports += "return require(path);";
                imports += "}";
                imports += `(${patchRequire})();`;
                imports += "const { constants: FsConstants } = require('fs');";
                imports += "const { readdir, access } = require('fs/promises');";
                imports += "const { join } = require('path');";
                imports += exists;
                imports += loader;
                imports += "loader()}";
                code += `(()=>{${imports}})();`;
            }
            return {
                contents: code,
                resolveDir: "./src"
            };
        });
    }
};

/** @type {import("esbuild").BuildOptions[]} */
const buildConfigs = ([
    // Discord Desktop main & renderer & preload
    {
        ...nodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/patcher.js",
        footer: { js: "//# sourceURL=file:///VencordPatcher\n" + sourceMapFooter("patcher") },
        sourcemap,
        plugins: [
            // @ts-ignore this is never undefined
            ...nodeCommonOpts.plugins,
            globNativesPlugin
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        ...commonOpts,
        entryPoints: ["src/Vencord.ts"],
        outfile: "dist/renderer.js",
        format: "iife",
        target: ["esnext"],
        footer: { js: "//# sourceURL=file:///VencordRenderer\n" + sourceMapFooter("renderer") },
        globalName: "Vencord",
        sourcemap,
        plugins: [
            globPlugins("discordDesktop"),
            ...commonRendererPlugins
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/preload.ts"],
        outfile: "dist/preload.js",
        footer: { js: "//# sourceURL=file:///VencordPreload\n" + sourceMapFooter("preload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "true",
            IS_VESKTOP: "false"
        }
    },

    // Vencord Desktop main & renderer & preload
    {
        ...nodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/vencordDesktopMain.js",
        footer: { js: "//# sourceURL=file:///VencordDesktopMain\n" + sourceMapFooter("vencordDesktopMain") },
        sourcemap,
        plugins: [
            ...nodeCommonOpts.plugins,
            globNativesPlugin
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    },
    {
        ...commonOpts,
        entryPoints: ["src/Vencord.ts"],
        outfile: "dist/vencordDesktopRenderer.js",
        format: "iife",
        target: ["esnext"],
        footer: { js: "//# sourceURL=file:///VencordDesktopRenderer\n" + sourceMapFooter("vencordDesktopRenderer") },
        globalName: "Vencord",
        sourcemap,
        plugins: [
            globPlugins("vesktop"),
            ...commonRendererPlugins
        ],
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    },
    {
        ...nodeCommonOpts,
        entryPoints: ["src/preload.ts"],
        outfile: "dist/vencordDesktopPreload.js",
        footer: { js: "//# sourceURL=file:///VencordPreload\n" + sourceMapFooter("vencordDesktopPreload") },
        sourcemap,
        define: {
            ...defines,
            IS_DISCORD_DESKTOP: "false",
            IS_VESKTOP: "true"
        }
    }
]);

await buildOrWatchAll(buildConfigs);
