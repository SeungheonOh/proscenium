import { useState } from "react";
import { scale, Screen, Shortcut, spring, Web, type OutputInfo } from "proscenium";
import { darkTheme, lightTheme, type Theme } from "proscenium/ui";
import { launchApplication, useApplications } from "../lib/system/applications.js";
import { menuTheme, webMenus } from "../lib/settings.js";
import { AppLauncher } from "./launcher/AppLauncher.js";
import launcherPage from "../pages/launcher/index.tsx?url";
import type {
  LauncherMessage,
  LauncherProps as LauncherPageProps,
} from "../pages/launcher/index.js";

const appear = spring({ duration: 0.22 });
const size = { width: 640, height: 420 };

interface LauncherProps {
  output?: OutputInfo;
  /** The React DOM page in Chromium it was before the kit could draw it; PROSCENIUM_WEB_MENUS=1 by default. */
  web?: boolean;
  /** The theme of the kit's launcher; dark unless PROSCENIUM_THEME says otherwise. */
  theme?: Theme;
}

/**
 * The application launcher on Super+D: drawn by the world with proscenium/ui, or, with
 * `web`, the page in Chromium it was.
 */
export function Launcher({ output, web = webMenus, theme }: LauncherProps) {
  if (web) return <WebLauncher output={output} />;
  return <AppLauncher output={output} theme={theme ?? (menuTheme === "light" ? lightTheme : darkTheme)} />;
}

/**
 * The launcher as a page. It stays mounted, so it opens instantly; a hidden page costs nothing.
 */
function WebLauncher({ output }: { output?: OutputInfo }) {
  const applications = useApplications();
  const [open, setOpen] = useState(false);
  const pageProps: LauncherPageProps = { applications, shown: open };

  function handleMessage(message: LauncherMessage) {
    if (message.name === "launch") launchApplication(message.value);
    setOpen(false);
  }

  return (
    <>
      <Shortcut keys="Super+D" onPress={() => setOpen((current) => !current)} />
      {output && (
        <Screen output={output.name}>
          <Web
            src={launcherPage}
            props={pageProps}
            autoFocus
            interactive={open}
            x={(output.width - size.width) / 2}
            y={output.height * 0.22}
            width={size.width}
            height={size.height}
            radius={16}
            blur={28}
            border={{ width: 1, color: "#ffffff22" }}
            shadow={{ color: "#00000080", blur: 48, y: 16 }}
            opacity={open ? 1 : 0}
            transform={scale(open ? 1 : 0.96)}
            transition={appear}
            onMessage={(name, value) => handleMessage({ name, value } as LauncherMessage)}
          />
        </Screen>
      )}
    </>
  );
}
