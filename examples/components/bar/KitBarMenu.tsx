/**
 * The bar's menus drawn by the world with proscenium/ui: sound and what is playing,
 * battery with display brightness and power mode, and clipboard history. Each is a
 * popover hanging under the item that opened it, measured before it shows, so it is as
 * tall as its content; Escape closes it, Tab moves through its controls.
 */

import { Box, Text, useClipboard } from "proscenium";
import {
  Button, Divider, IconButton, Label, List, ListItem, makeStyles, Popover, ScrollView, SegmentedControl, Slider,
  StyleSheet, ThemeProvider, Tooltip, type Theme,
} from "proscenium/ui";
import { useBattery, type BatteryInfo } from "../../lib/system/battery.js";
import { setBrightness, useBrightness, type BrightnessInfo } from "../../lib/system/brightness.js";
import { mediaCommand, useMedia, type MediaInfo } from "../../lib/system/media.js";
import { setPowerProfile, usePowerProfile, type PowerProfileInfo } from "../../lib/system/power.js";
import { setVolume, toggleMute, useVolume, type VolumeInfo } from "../../lib/system/sound.js";
import nextIcon from "../../icons/next.svg";
import pauseIcon from "../../icons/pause.svg";
import playIcon from "../../icons/play.svg";
import previousIcon from "../../icons/previous.svg";
import type { OpenMenu } from "./BarMenu.js";
import { barLayout } from "./layout.js";
import type { MenuKind } from "../../pages/bar-menu/index.js";

const menuWidth: Record<MenuKind, number> = { sound: 320, battery: 320, clipboard: 360 };
const padding = 16;
const clipRow = 30, clipGap = 2, clipRows = 6;

export const profileNames: Record<string, string> = {
  "power-saver": "Saver",
  balanced: "Balanced",
  performance: "Performance",
};

const useStyles = makeStyles(({ colors, glassBorder, type }) => StyleSheet.create({
  surface: { flexDirection: "column", gap: 12, padding: 14, paddingX: padding, radius: 14, fill: colors.glass, blur: 24,
             border: glassBorder, shadow: [{ color: "#00000014", blur: 3, y: 1 }, { color: "#0000002e", blur: 34, y: 12, spread: -6 }] },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  grow: { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
  round: { radius: 16 },
  play: { radius: 18 },
  big: { ...type.title, size: 28, lineHeight: 34 / 28, letterSpacing: -0.6, color: colors.ink, tabularNumbers: true },
  // Level with the middle of the figures, which sit low in their line, not with the line's.
  badge: { height: 22, paddingX: 8, radius: 11, fill: colors.hover, justifyContent: "center", marginTop: 3 },
  charging: { fill: colors.accentSoft },
  divider: { marginX: -padding, marginY: 0 },
  entry: { minHeight: clipRow, height: clipRow, paddingX: 8, marginX: -8 },
  mono: { font: "Noto Sans Mono, monospace", size: 12 },
}));

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function describeBattery(battery: BatteryInfo) {
  if (battery.full) return "Fully charged";
  if (battery.pluggedIn && !battery.charging) return "Plugged in";
  const remaining = battery.minutes === null ? null : formatDuration(battery.minutes);
  if (battery.charging) return remaining ? `Charging · ${remaining} to full` : "Charging";
  return remaining ? `${remaining} left` : "On battery";
}

function NowPlaying({ media }: { media: MediaInfo }) {
  const styles = useStyles();
  const subtitle = [media.artist, media.identity].filter(Boolean).join(" · ");
  return (
    <>
      <Box style={styles.row}>
        <Box style={styles.grow}>
          <Label variant="strong">{media.title}</Label>
          <Label variant="small">{subtitle}</Label>
        </Box>
        <Tooltip content="Previous">
          <IconButton icon={previousIcon} size={32} iconSize={14} style={styles.round} disabled={!media.canPrevious}
                      onPress={() => mediaCommand("Previous")} />
        </Tooltip>
        <Tooltip content={media.playing ? "Pause" : "Play"}>
          <IconButton icon={media.playing ? pauseIcon : playIcon} variant="filled" size={36} iconSize={16} style={styles.play}
                      onPress={() => mediaCommand("PlayPause")} />
        </Tooltip>
        <Tooltip content="Next">
          <IconButton icon={nextIcon} size={32} iconSize={14} style={styles.round} disabled={!media.canNext}
                      onPress={() => mediaCommand("Next")} />
        </Tooltip>
      </Box>
      <Divider style={styles.divider} />
    </>
  );
}

function SoundMenu({ width, volume, media }: { width: number; volume: VolumeInfo | null; media: MediaInfo | null }) {
  const styles = useStyles();
  if (!volume) return <Label tone="muted">No sound output</Label>;
  const percent = Math.round(volume.volume * 100);
  return (
    <>
      {media?.title && <NowPlaying media={media} />}
      <Box style={styles.between}>
        <Label variant="strong">Sound</Label>
        <Label tone="muted" tabularNumbers>{volume.muted ? "Muted" : `${percent}%`}</Label>
      </Box>
      <Slider width={width} min={0} max={100} step={1} value={volume.muted ? 0 : Math.min(percent, 100)}
              onValueChange={(value) => setVolume(value / 100)} />
      <Box style={styles.between}>
        <Label tone="muted" flexShrink={1}>{volume.device}</Label>
        <Button size="small" variant="outline" selected={volume.muted} label={volume.muted ? "Unmute" : "Mute"}
                onPress={toggleMute} />
      </Box>
    </>
  );
}

function BatteryMenu({ width, battery, profile, brightness }: { width: number; battery: BatteryInfo | null;
  profile: PowerProfileInfo | null; brightness: BrightnessInfo | null }) {
  const styles = useStyles();
  return (
    <>
      <Box style={styles.row}>
        <Text style={styles.big}>{battery ? `${battery.percent}%` : "—"}</Text>
        <Box style={[styles.badge, battery?.charging && styles.charging]}>
          <Label variant="small" tone={battery?.charging ? "accent" : "soft"}>
            {battery ? describeBattery(battery) : "No battery"}
          </Label>
        </Box>
        {battery?.watts ? <Label tone="muted" tabularNumbers>{`${battery.watts} W`}</Label> : null}
      </Box>
      {brightness && (
        <>
          <Box style={styles.between}>
            <Label variant="strong">Display</Label>
            <Label tone="muted" tabularNumbers>{`${brightness.percent}%`}</Label>
          </Box>
          <Slider width={width} min={1} max={100} step={1} value={brightness.percent}
                  onValueChange={(value) => setBrightness(value)} />
        </>
      )}
      {profile && (
        <SegmentedControl options={profile.available.map((name) => ({ value: name, label: profileNames[name] ?? name }))}
                          value={profile.current} onChange={setPowerProfile} segmentStyle={{ flexGrow: 1 }} />
      )}
    </>
  );
}

function ClipboardMenu({ onClose, history, clipboard }: { onClose: () => void; history: readonly string[];
  clipboard: { copy: (text: string) => void; clear: () => void } }) {
  const styles = useStyles();
  const entries = history.slice(0, 12);
  const height = Math.min(entries.length, clipRows) * (clipRow + clipGap) - clipGap;
  return (
    <>
      <Box style={styles.between}>
        <Label variant="strong">Clipboard</Label>
        {entries.length > 0 && <Button size="small" variant="tinted" label="Clear" onPress={clipboard.clear} />}
      </Box>
      {entries.length === 0 ? <Label tone="muted">Copied text appears here.</Label> : (
        <ScrollView height={height}>
          <List gap={clipGap}>
            {entries.map((text) => (
              <ListItem key={text} style={styles.entry} labelStyle={styles.mono} label={text.replace(/\s+/g, " ").slice(0, 200)}
                        onPress={() => {
                          clipboard.copy(text);
                          onClose();
                        }}
                        menu={[{ label: "Copy", onSelect: () => { clipboard.copy(text); onClose(); } },
                               "-", { label: "Clear history", danger: true, onSelect: clipboard.clear }]} />
            ))}
          </List>
        </ScrollView>
      )}
    </>
  );
}

interface KitBarMenuProps {
  menu: OpenMenu | null;
  onClose: () => void;
  theme: Theme;
}

/** The open bar menu, hanging from the right edge of the item that opened it. */
export function KitBarMenu({ menu, onClose, theme }: KitBarMenuProps) {
  if (!menu) return null;
  return (
    <ThemeProvider theme={theme}>
      <MenuSurface key={menu.opened} menu={menu} onClose={onClose} />
    </ThemeProvider>
  );
}

/** What the menus show: the system's state, given rather than read so a test can show any. */
export interface BarMenuState {
  volume: VolumeInfo | null;
  media: MediaInfo | null;
  battery: BatteryInfo | null;
  profile: PowerProfileInfo | null;
  brightness: BrightnessInfo | null;
  history: readonly string[];
  clipboard: { copy: (text: string) => void; clear: () => void };
}

function MenuSurface({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  const clipboard = useClipboard();
  const state: BarMenuState = {
    volume: useVolume(), media: useMedia(), battery: useBattery(), profile: usePowerProfile(),
    brightness: useBrightness(), history: clipboard.history, clipboard,
  };
  return <BarMenuSurface menu={menu} onClose={onClose} state={state} />;
}

/** One menu with STATE, hanging under its item. */
export function BarMenuSurface({ menu, onClose, state }: { menu: OpenMenu; onClose: () => void; state: BarMenuState }) {
  const styles = useStyles();
  const width = menuWidth[menu.kind];
  const inner = width - 2 * padding;
  return (
    // The bar's strip closes it on a press outside, so it catches none itself.
    <Popover open onClose={onClose} modal={false} anchor={{ output: menu.output, x: menu.right, y: barLayout.reserve - 4 }}
             align="end" gap={0} style={[styles.surface, { width }]}>
      {menu.kind === "sound" && <SoundMenu width={inner} volume={state.volume} media={state.media} />}
      {menu.kind === "battery" && (
        <BatteryMenu width={inner} battery={state.battery} profile={state.profile} brightness={state.brightness} />
      )}
      {menu.kind === "clipboard" && <ClipboardMenu onClose={onClose} history={state.history} clipboard={state.clipboard} />}
    </Popover>
  );
}
