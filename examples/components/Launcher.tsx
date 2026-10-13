import { useState } from "react";
import { scale, Screen, Shortcut, spring, Web, type OutputInfo } from "proscenium";
import { launchApplication, useApplications } from "../lib/system/applications.js";
import launcherPage from "../pages/launcher/index.tsx?url";
import type {
  LauncherMessage,
  LauncherProps as LauncherPageProps,
} from "../pages/launcher/index.js";

const appear = spring({ duration: 0.22 });
const size = { width: 640, height: 420 };

interface LauncherProps {
  output?: OutputInfo;
}

/**
 * The application launcher on Super+D. It stays mounted, so it opens instantly;
 * a hidden page costs nothing.
 */
export function Launcher({ output }: LauncherProps) {
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
