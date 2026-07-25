import { Language, Node, Parser } from "web-tree-sitter";

export interface ShellWord {
  text: string;
  dynamic: boolean;
}

export interface ShellCommand {
  words: ShellWord[];
}

export interface ShellAst {
  commands: ShellCommand[];
  outputRedirects: string[];
  hasCommandSubstitution: boolean;
  error?: string;
}

const DYNAMIC_NODE_TYPES = ["arithmetic_expansion", "command_substitution", "expansion", "process_substitution", "simple_expansion"];
const COMMAND_SUBSTITUTION_TYPES = ["command_substitution", "process_substitution"];
let parserPromise: Promise<Parser> | undefined;

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

function decodeAnsiEscape(source: string, slashIndex: number): { value: string; endIndex: number } {
  const escapedCharacter = source[slashIndex + 1];
  if (Object.hasOwn(ANSI_ESCAPES, escapedCharacter)) {
    return { value: ANSI_ESCAPES[escapedCharacter], endIndex: slashIndex + 1 };
  }
  if (escapedCharacter === "x") {
    const digits = source.slice(slashIndex + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0] ?? "";
    if (digits) return { value: String.fromCodePoint(Number.parseInt(digits, 16)), endIndex: slashIndex + 1 + digits.length };
  }
  if (escapedCharacter === "u" || escapedCharacter === "U") {
    const length = escapedCharacter === "u" ? 4 : 8;
    const digits = source.slice(slashIndex + 2, slashIndex + 2 + length);
    if (digits.length === length && /^[0-9A-Fa-f]+$/.test(digits)) {
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint <= 0x10ffff) return { value: String.fromCodePoint(codePoint), endIndex: slashIndex + 1 + length };
    }
  }
  const octalDigits = source.slice(slashIndex + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
  if (octalDigits) return { value: String.fromCodePoint(Number.parseInt(octalDigits, 8)), endIndex: slashIndex + octalDigits.length };
  return { value: escapedCharacter ?? "", endIndex: slashIndex + 1 };
}

function decodeStaticWord(source: string): string {
  let value = "";
  let quote: "'" | '"' | "ansi" | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "ansi") {
      if (character === "'") quote = null;
      else if (character === "\\") {
        const decoded = decodeAnsiEscape(source, index);
        value += decoded.value;
        index = decoded.endIndex;
      } else value += character;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "\\" && index + 1 < source.length && /[$`"\\\n]/.test(source[index + 1])) {
        index += 1;
        if (source[index] !== "\n") value += source[index];
      } else value += character;
      continue;
    }
    if (character === "$" && source[index + 1] === "'") {
      quote = "ansi";
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\" && index + 1 < source.length) {
      index += 1;
      if (source[index] !== "\n") value += source[index];
    } else {
      value += character;
    }
  }
  return value;
}

function containsDynamicExpansion(node: Node): boolean {
  return DYNAMIC_NODE_TYPES.includes(node.type) || node.descendantsOfType(DYNAMIC_NODE_TYPES).length > 0;
}

function toShellWord(node: Node): ShellWord {
  const dynamic = containsDynamicExpansion(node);
  return { text: dynamic ? node.text : decodeStaticWord(node.text), dynamic };
}

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const grammarPath = decodeURIComponent(new URL("../node_modules/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url).pathname);
      const language = await Language.load(grammarPath);
      return new Parser().setLanguage(language);
    })();
  }
  return parserPromise;
}

export async function parseShellAst(source: string): Promise<ShellAst> {
  let tree;
  try {
    const parser = await getParser();
    tree = parser.parse(source);
    if (!tree || tree.rootNode.hasError) {
      return { commands: [], outputRedirects: [], hasCommandSubstitution: false, error: "unsupported or incomplete shell syntax" };
    }

    const commands = tree.rootNode
      .descendantsOfType("command")
      .map((commandNode) => {
        const name = commandNode.childForFieldName("name");
        const words = name ? [toShellWord(name)] : [];
        for (const argument of commandNode.childrenForFieldName("argument")) words.push(toShellWord(argument));
        return { words };
      })
      .filter((command) => command.words.length > 0);
    const outputRedirects = tree.rootNode
      .descendantsOfType("file_redirect")
      .map((redirect) => redirect.text)
      .filter((redirect) => /^\s*\d*(?:>>?|>\||&>>?|>&)/.test(redirect));
    const hasCommandSubstitution = tree.rootNode.descendantsOfType(COMMAND_SUBSTITUTION_TYPES).length > 0;
    return { commands, outputRedirects, hasCommandSubstitution };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    return { commands: [], outputRedirects: [], hasCommandSubstitution: false, error: message };
  } finally {
    tree?.delete();
  }
}
