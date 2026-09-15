import { InputRule, mergeAttributes, Node, nodePasteRule } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";

import { humanize, isValidPlaceholderName, placeholderSyntax } from "@/domain/placeholder";
import { EDITOR_NODES } from "@/lib/editor-document";
import { cn } from "@/lib/utils";

/** A whole placeholder as typed: `{{.nome}}`, with the spaces Word tolerates. */
const TYPED = /\{\{\s*\.([a-z][a-z0-9_]*)\s*\}\}$/;
const PASTED = /\{\{\s*\.([a-z][a-z0-9_]*)\s*\}\}/g;

/**
 * A placeholder in the editor: one inline atom, never text.
 *
 * Being an atom is the point. The caret steps over it, Backspace removes it
 * whole, and no edit can leave `{{.loca` behind, which the API would refuse.
 * It carries marks like text does, so a bold field is generated bold.
 *
 * Typing or pasting `{{.nome}}` becomes a field, so an author who knows the
 * syntax from Word loses nothing. It copies out as that syntax, too.
 */
export const Field = Node.create({
  name: EDITOR_NODES.field,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-field"),
        renderHTML: (attributes) => ({ "data-field": attributes.name }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-field]",
        getAttrs: (element) => (isValidPlaceholderName(element.getAttribute("data-field") ?? "") ? null : false),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), placeholderSyntax(String(node.attrs.name))];
  },

  renderText({ node }) {
    return placeholderSyntax(String(node.attrs.name));
  },

  addNodeView() {
    return ReactNodeViewRenderer(FieldChip, { as: "span", className: "inline" });
  },

  addInputRules() {
    return [
      new InputRule({
        find: TYPED,
        handler: ({ state, range, match }) => {
          const name = match[1];
          if (name === undefined || !isValidPlaceholderName(name)) return null;
          // The closing brace being typed is not in the document yet; replacing
          // the range swallows it along with the rest of the syntax.
          state.tr.replaceWith(range.from, range.to, this.type.create({ name }));
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      nodePasteRule({
        find: PASTED,
        type: this.type,
        getAttributes: (match) => (isValidPlaceholderName(match[1] ?? "") ? { name: match[1] } : false),
      }),
    ];
  },
});

function FieldChip({ node, selected }: ReactNodeViewProps) {
  const name = String(node.attrs.name);
  const marks = new Set(node.marks.map((mark) => mark.type.name));

  return (
    <NodeViewWrapper
      as="span"
      data-field-chip=""
      aria-label={`Campo ${humanize(name)}`}
      className={cn(
        "mx-0.5 inline-block cursor-default rounded-[4px] border border-docs/40 bg-docs/12 px-1.5 py-px align-baseline font-mono text-xs leading-normal text-docs-soft",
        marks.has("bold") && "font-semibold",
        marks.has("italic") && "italic",
        marks.has("underline") && "underline",
        selected && "border-primary ring-[3px] ring-ring/30",
      )}
    >
      {placeholderSyntax(name)}
    </NodeViewWrapper>
  );
}
