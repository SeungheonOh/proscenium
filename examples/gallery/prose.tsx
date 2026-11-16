import { Box, Text } from "proscenium";
import { Column, useTheme } from "proscenium/ui";
import { Note, onDark, onLight, SectionFrame } from "./common.js";

const paragraph =
  "The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow.";

export default function ProseSection() {
  const { font, colors } = useTheme();
  const chromeInk = colors.ink;
  return (
    <SectionFrame title="Text: paragraph, digits, scripts" grow={282}>
      <Box flexDirection="row" gap={8}>
        <Box flexGrow={1} flexBasis={0} padding={8} radius={8} fill={onLight.bg}>
          <Text font={font} size={13} weight={400} color={onLight.ink} lineHeight={18 / 13}>{paragraph}</Text>
        </Box>
        <Box flexGrow={1} flexBasis={0} padding={8} radius={8} fill={onDark.bg}>
          <Text font={font} size={13} weight={400} color={onDark.ink} lineHeight={18 / 13}>{paragraph}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={8}>
        <Column flexGrow={1} flexBasis={0} gap={2}>
          <Note>digits, 20 px / 650</Note>
          <Text font={font} size={20} weight={650} color={chromeInk}>12:34:56</Text>
          <Text font={font} size={20} weight={650} color={chromeInk}>00:11 23:59</Text>
        </Column>
        <Column flexGrow={1} flexBasis={0} gap={2}>
          <Note>digits, 12 px / 500</Note>
          <Text font={font} size={12} weight={500} color={chromeInk}>1,234,567.89  0O 1lI</Text>
          <Text font={font} size={12} weight={500} color={chromeInk}>-+=x/% 5S 8B 2Z</Text>
        </Column>
      </Box>
      <Column gap={2}>
        <Note>mixed scripts and italics, 13 px</Note>
        <Text font={font} size={13} weight={500} color={chromeInk}>Grüße, Ελληνικά, Кириллица, ñandú, ĳ</Text>
        <Text font={font} size={13} weight={500} color={chromeInk}>日本語のテキスト  한국어  हिन्दी  עברית  ภาษาไทย</Text>
        <Text font={font} size={13} weight={500} italic color={chromeInk}>Italic text, and <Text weight={700}>bold</Text> within it</Text>
      </Column>
    </SectionFrame>
  );
}

