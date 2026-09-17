import { Extension, Node, type CommandProps } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { FontSize } from "@tiptap/extension-text-style";

import { LINE_SPACINGS, MAX_INDENT, type LineSpacing } from "@imobiliary/docx/blocks";
import { EDITOR_NODES, pointsOf } from "@/lib/editor-document";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphFormat: {
      /** Line spacing for the selected paragraphs; null follows the style. */
      setLineSpacing: (spacing: LineSpacing | null) => ReturnType;
      /** One step deeper: a list item nests, any other paragraph indents. */
      increaseIndent: () => ReturnType;
      /** One step back out. */
      decreaseIndent: () => ReturnType;
      toggleFirstLineIndent: () => ReturnType;
    };
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

const TEXT_BLOCKS = ["paragraph", "heading"];

/** How a paragraph setting is drawn in the editor, mirroring the preview. */
const INDENT_REM = 2;

/**
 * Paragraph settings the model holds and TipTap has no extension for: line
 * spacing, left indentation and the first-line indent. They are attributes on
 * paragraphs and headings, drawn with inline styles and carried through copy
 * and paste in data attributes.
 */
export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",

  addGlobalAttributes() {
    return [
      {
        types: TEXT_BLOCKS,
        attributes: {
          lineSpacing: {
            default: null,
            parseHTML: (element) => {
              const value = Number(element.getAttribute("data-line-spacing"));
              return (LINE_SPACINGS as readonly number[]).includes(value) ? value : null;
            },
            renderHTML: (attributes) =>
              attributes.lineSpacing === null
                ? {}
                : {
                    "data-line-spacing": attributes.lineSpacing,
                    // 1.45 turns Word's multiple into this page's line height,
                    // so its 1.15 default lands on the 1.7 paragraphs use.
                    style: `line-height: ${Number(attributes.lineSpacing) * 1.45}`,
                  },
          },
          indent: {
            default: 0,
            parseHTML: (element) => {
              const value = Number(element.getAttribute("data-indent"));
              return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_INDENT) : 0;
            },
            renderHTML: (attributes) =>
              attributes.indent > 0
                ? { "data-indent": attributes.indent, style: `margin-left: ${Number(attributes.indent) * INDENT_REM}rem` }
                : {},
          },
          firstLineIndent: {
            default: false,
            parseHTML: (element) => element.hasAttribute("data-first-line-indent"),
            renderHTML: (attributes) =>
              attributes.firstLineIndent
                ? { "data-first-line-indent": "", style: `text-indent: ${INDENT_REM}rem` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineSpacing:
        (spacing) =>
        ({ commands }) =>
          TEXT_BLOCKS.map((type) => commands.updateAttributes(type, { lineSpacing: spacing })).some(Boolean),

      increaseIndent: () => (props) => shiftIndent(props, 1),
      decreaseIndent: () => (props) => shiftIndent(props, -1),

      toggleFirstLineIndent:
        () =>
        ({ state, commands }) => {
          const current = state.selection.$from.parent.attrs.firstLineIndent === true;
          return TEXT_BLOCKS.map((type) => commands.updateAttributes(type, { firstLineIndent: !current })).some(Boolean);
        },
    };
  },
});

/**
 * Inside a list, indentation is the list's level, which the list commands
 * own. Elsewhere it is a step of left indentation on each selected block.
 */
function shiftIndent({ state, tr, dispatch, commands }: CommandProps, delta: 1 | -1): boolean {
  if (isInList(state.selection.$from)) {
    return delta > 0 ? commands.sinkListItem(EDITOR_NODES.listItem) : commands.liftListItem(EDITOR_NODES.listItem);
  }

  let changed = false;
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!TEXT_BLOCKS.includes(node.type.name)) return true;
    const indent = Math.min(MAX_INDENT, Math.max(0, Number(node.attrs.indent ?? 0) + delta));
    if (indent !== node.attrs.indent) {
      tr.setNodeMarkup(position, undefined, { ...node.attrs, indent });
      changed = true;
    }
    return false;
  });
  if (changed) dispatch?.(tr);
  return changed;
}

function isInList($position: CommandProps["state"]["selection"]["$from"]): boolean {
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    if ($position.node(depth).type.name === EDITOR_NODES.listItem) return true;
  }
  return false;
}

/**
 * A manual page break, as its own block. Ctrl+Enter inserts one, as in Word.
 */
export const PageBreak = Node.create({
  name: EDITOR_NODES.pageBreak,
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-page-break]" }];
  },

  renderHTML() {
    return [
      "div",
      { "data-page-break": "", role: "separator", "aria-label": "Quebra de página", class: "page-break" },
      ["span", {}, "Quebra de página"],
    ];
  },

  addCommands() {
    return {
      /**
       * Breaks the page where the caret is and leaves the caret after the
       * break, as Word does: the paragraph is split, the break goes between
       * the halves, and typing continues on the new page. Not inside a list,
       * whose items cannot hold a block of their own.
       */
      setPageBreak:
        () =>
        ({ state, chain }) => {
          if (isInList(state.selection.$from)) return false;
          return chain()
            .splitBlock()
            .command(({ tr }) => {
              const before = tr.selection.$from.before();
              tr.insert(before, this.type.create());
              return true;
            })
            .run();
        },
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});

/**
 * A list item holds one paragraph and deeper lists, nothing else. That is what
 * a .docx list is: one numbered paragraph per item. TipTap's default also
 * allows headings and several paragraphs per item, which a flat tree of
 * numbered paragraphs could not give back unchanged.
 */
export const SingleParagraphListItem = ListItem.extend({
  content: `paragraph (${EDITOR_NODES.bulletList} | ${EDITOR_NODES.orderedList})*`,
});

/** Word holds one vertical alignment per run, so the two exclude each other. */
export const ExclusiveSuperscript = Superscript.extend({ excludes: "subscript" });
export const ExclusiveSubscript = Subscript.extend({ excludes: "superscript" });

/**
 * Font size in points, as Word has it, but drawn in rem. TipTap's own writes
 * `font-size: 12pt`, a fixed size that would ignore the text-size preference
 * in Ajustes; at the default 16px root, 1rem is exactly 12pt, so points / 12
 * rem draws the same size and still follows the preference. The attribute
 * keeps "12pt", which is what the conversion to blocks reads.
 */
export const PointFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: [EDITOR_NODES.textStyle],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => {
              const value = element.getAttribute("data-font-size") ?? element.style.fontSize;
              const points = pointsOf(value);
              return points === null ? null : `${points}pt`;
            },
            renderHTML: (attributes) => {
              const points = pointsOf(attributes.fontSize);
              return points === null
                ? {}
                : { "data-font-size": `${points}pt`, style: `font-size: ${points / 12}rem` };
            },
          },
        },
      },
    ];
  },
});
