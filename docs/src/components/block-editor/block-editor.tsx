import {
  IconAlignCenter,
  IconAlignJustified,
  IconAlignLeft,
  IconAlignRight,
  IconArrowBackUp,
  IconArrowBarToRight,
  IconArrowForwardUp,
  IconBold,
  IconBraces,
  IconCheck,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconList,
  IconListNumbers,
  IconPageBreak,
  IconPencil,
  IconPlus,
  IconStrikethrough,
  IconSubscript,
  IconSuperscript,
  IconUnderline,
  IconX,
} from "@tabler/icons-react";
import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Heading from "@tiptap/extension-heading";
import Italic from "@tiptap/extension-italic";
import { BulletList, ListKeymap, OrderedList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Field } from "@/components/block-editor/field";
import {
  ExclusiveSubscript,
  ExclusiveSuperscript,
  PageBreak,
  ParagraphFormat,
  PointFontSize,
  SingleParagraphListItem,
} from "@/components/block-editor/formatting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FONT_SIZES,
  LINE_SPACINGS,
  type Alignment,
  type Block,
  type BlockType,
  type LineSpacing,
} from "@/domain/block";
import {
  groupPlaceholders,
  humanize,
  isValidPlaceholderName,
  MAX_PLACEHOLDER_NAME_LENGTH,
  placeholderSyntax,
  toPlaceholderName,
} from "@/domain/placeholder";
import { blocksToEditor, EDITOR_NODES, editorToBlocks, pointsOf } from "@/lib/editor-document";
import { cn } from "@/lib/utils";

/**
 * The block editor: a document you write in, with fields as chips.
 *
 * The schema is closed on purpose. It holds exactly what a template authored
 * here can be — headings 1 to 3, paragraphs, bold, italic, underline, line
 * breaks and fields — because the .docx writer writes exactly that. Anything
 * pasted from elsewhere (tables, colours, lists, images) is reduced to its text
 * by ProseMirror's own parser, so the editor never holds something the file
 * could not carry.
 *
 * It renders only in the browser: `immediatelyRender: false` leaves the server
 * an empty frame instead of a document it cannot build.
 */
export function BlockEditor({
  initialBlocks,
  onChange,
  label,
  error,
}: {
  readonly initialBlocks: readonly Block[];
  readonly onChange: (blocks: Block[]) => void;
  /** What the document area is announced as. */
  readonly label: string;
  readonly error?: string | undefined;
}) {
  const errorId = useId();
  const [blocks, setBlocks] = useState<readonly Block[]>(initialBlocks);
  const report = useRef(onChange);
  report.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    injectCSS: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Heading.configure({ levels: [1, 2, 3] }),
      Bold,
      Italic,
      Underline,
      Strike,
      ExclusiveSuperscript,
      ExclusiveSubscript,
      TextStyle,
      PointFontSize,
      TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
      ParagraphFormat,
      BulletList,
      OrderedList,
      SingleParagraphListItem,
      ListKeymap,
      HardBreak,
      PageBreak,
      UndoRedo,
      Field,
      Placeholder.configure({ placeholder: "Comece a escrever o modelo…" }),
    ],
    content: blocksToEditor(initialBlocks),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        class: "min-h-[28rem] outline-none",
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = editorToBlocks(current.getJSON());
      setBlocks(next);
      report.current(next);
    },
  });

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-w-0 flex-col gap-2">
        <div
          className={cn(
            "flex flex-col overflow-hidden rounded-lg border bg-card focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
            error === undefined ? "border-border" : "border-destructive/70",
          )}
        >
          <Toolbar editor={editor} fields={placeholdersIn(blocks)} />
          <div
            className="block-editor-content px-5 py-6 md:px-8 md:py-7"
            onClick={(event) => {
              // A click in the padding still puts the caret in the document.
              if (event.target === event.currentTarget) editor?.commands.focus("end");
            }}
          >
            {editor === null ? (
              <p className="min-h-[28rem] text-sm text-faint">Carregando o editor…</p>
            ) : (
              <EditorContent editor={editor} />
            )}
          </div>
        </div>
        {error !== undefined && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="text-caption leading-relaxed text-faint">
          Atalhos: Ctrl+B, Ctrl+I e Ctrl+U para negrito, itálico e sublinhado; Shift+Enter quebra a
          linha e Ctrl+Enter, a página; Tab e Shift+Tab mudam o nível de um item de lista; digite{" "}
          <code className="font-mono text-docs">{"{{.nome_do_campo}}"}</code> para criar um campo sem
          sair do teclado.
        </p>
      </div>

      <FieldsPanel editor={editor} blocks={blocks} />
    </div>
  );
}

/** Field names in order of first appearance, with how often each appears. */
function placeholdersIn(blocks: readonly Block[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    for (const segment of block.segments) {
      if (segment.kind === "placeholder") counts.set(segment.name, (counts.get(segment.name) ?? 0) + 1);
    }
  }
  return counts;
}

// ----- toolbar ---------------------------------------------------------

const BLOCK_OPTIONS: readonly { readonly value: BlockType; readonly label: string }[] = [
  { value: "paragraph", label: "Parágrafo" },
  { value: "heading1", label: "Título 1" },
  { value: "heading2", label: "Título 2" },
  { value: "heading3", label: "Título 3" },
];

const ALIGN_OPTIONS: readonly { readonly value: Alignment; readonly label: string; readonly icon: ReactNode }[] = [
  { value: "left", label: "Alinhar à esquerda", icon: <IconAlignLeft /> },
  { value: "center", label: "Centralizar", icon: <IconAlignCenter /> },
  { value: "right", label: "Alinhar à direita", icon: <IconAlignRight /> },
  { value: "justify", label: "Justificar", icon: <IconAlignJustified /> },
];

const SPACING_LABEL: Record<LineSpacing, string> = {
  1: "Simples",
  1.15: "1,15",
  1.5: "1,5",
  2: "Duplo",
};

const SELECT_CLASS =
  "h-8 rounded-md border border-input-border bg-input px-2 text-small text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:opacity-50";

/**
 * The formatting bar. Controls come in the order a word processor puts them:
 * paragraph kind and size, text emphasis, alignment, lists and indentation,
 * spacing and breaks, history, and the fields at the end. Each toggle says
 * whether it is on with aria-pressed, and the whole bar is one toolbar
 * landmark.
 */
function Toolbar({
  editor,
  fields,
}: {
  readonly editor: Editor | null;
  readonly fields: ReadonlyMap<string, number>;
}) {
  const [inserting, setInserting] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (current === null) return null;
      const paragraph = current.state.selection.$from.parent;
      return {
        block: (current.isActive("heading", { level: 1 })
          ? "heading1"
          : current.isActive("heading", { level: 2 })
            ? "heading2"
            : current.isActive("heading", { level: 3 })
              ? "heading3"
              : "paragraph") as BlockType,
        size: pointsOf(current.getAttributes(EDITOR_NODES.textStyle).fontSize),
        bold: current.isActive("bold"),
        italic: current.isActive("italic"),
        underline: current.isActive("underline"),
        strike: current.isActive("strike"),
        superscript: current.isActive("superscript"),
        subscript: current.isActive("subscript"),
        align: (paragraph.attrs.textAlign ?? null) as Alignment | null,
        bulletList: current.isActive(EDITOR_NODES.bulletList),
        orderedList: current.isActive(EDITOR_NODES.orderedList),
        lineSpacing: (paragraph.attrs.lineSpacing ?? null) as LineSpacing | null,
        firstLineIndent: paragraph.attrs.firstLineIndent === true,
        inList: current.isActive(EDITOR_NODES.listItem),
        canIndent: current.can().increaseIndent(),
        canOutdent: current.can().decreaseIndent(),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      };
    },
  });

  const disabled = editor === null || state === null;
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (editor !== null) command(editor.chain().focus()).run();
  };

  function setBlock(type: BlockType) {
    run((chain) =>
      type === "paragraph"
        ? chain.setParagraph()
        : chain.setHeading({ level: type === "heading1" ? 1 : type === "heading2" ? 2 : 3 }),
    );
  }

  return (
    <div className="border-b border-border bg-raised">
      <div role="toolbar" aria-label="Formatação" className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        <select
          aria-label="Tipo de parágrafo"
          disabled={disabled || state?.inList}
          value={state?.block ?? "paragraph"}
          onChange={(event) => setBlock(event.currentTarget.value as BlockType)}
          className={SELECT_CLASS}
        >
          {BLOCK_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Tamanho da fonte"
          disabled={disabled}
          value={state?.size === null || state === null ? "" : String(state.size)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            run((chain) => (value === "" ? chain.unsetFontSize() : chain.setFontSize(`${value}pt`)));
          }}
          className={cn(SELECT_CLASS, "w-[5.5rem]")}
        >
          <option value="">Padrão</option>
          {/* A size read from the document that the list does not offer still shows. */}
          {state?.size != null && !(FONT_SIZES as readonly number[]).includes(state.size) && (
            <option value={String(state.size)}>{String(state.size).replace(".", ",")} pt</option>
          )}
          {FONT_SIZES.map((size) => (
            <option key={size} value={String(size)}>
              {size} pt
            </option>
          ))}
        </select>

        <Separator />
        <ToggleButton label="Negrito" active={state?.bold ?? false} disabled={disabled} onClick={() => run((c) => c.toggleBold())}>
          <IconBold />
        </ToggleButton>
        <ToggleButton label="Itálico" active={state?.italic ?? false} disabled={disabled} onClick={() => run((c) => c.toggleItalic())}>
          <IconItalic />
        </ToggleButton>
        <ToggleButton label="Sublinhado" active={state?.underline ?? false} disabled={disabled} onClick={() => run((c) => c.toggleUnderline())}>
          <IconUnderline />
        </ToggleButton>
        <ToggleButton label="Tachado" active={state?.strike ?? false} disabled={disabled} onClick={() => run((c) => c.toggleStrike())}>
          <IconStrikethrough />
        </ToggleButton>
        <ToggleButton label="Sobrescrito" active={state?.superscript ?? false} disabled={disabled} onClick={() => run((c) => c.toggleSuperscript())}>
          <IconSuperscript />
        </ToggleButton>
        <ToggleButton label="Subscrito" active={state?.subscript ?? false} disabled={disabled} onClick={() => run((c) => c.toggleSubscript())}>
          <IconSubscript />
        </ToggleButton>

        <Separator />
        {ALIGN_OPTIONS.map((option) => (
          <ToggleButton
            key={option.value}
            label={option.label}
            active={(state?.align ?? "left") === option.value}
            disabled={disabled}
            onClick={() => run((c) => (option.value === "left" ? c.unsetTextAlign() : c.setTextAlign(option.value)))}
          >
            {option.icon}
          </ToggleButton>
        ))}

        <Separator />
        <ToggleButton
          label="Lista com marcadores"
          active={state?.bulletList ?? false}
          disabled={disabled || (state?.block ?? "paragraph") !== "paragraph"}
          onClick={() => run((c) => c.toggleBulletList())}
        >
          <IconList />
        </ToggleButton>
        <ToggleButton
          label="Lista numerada"
          active={state?.orderedList ?? false}
          disabled={disabled || (state?.block ?? "paragraph") !== "paragraph"}
          onClick={() => run((c) => c.toggleOrderedList())}
        >
          <IconListNumbers />
        </ToggleButton>
        <IconAction label="Diminuir recuo" disabled={disabled || !state?.canOutdent} onClick={() => run((c) => c.decreaseIndent())}>
          <IconIndentDecrease />
        </IconAction>
        <IconAction label="Aumentar recuo" disabled={disabled || !state?.canIndent} onClick={() => run((c) => c.increaseIndent())}>
          <IconIndentIncrease />
        </IconAction>
        <ToggleButton
          label="Recuo da primeira linha"
          active={state?.firstLineIndent ?? false}
          disabled={disabled || (state?.inList ?? false)}
          onClick={() => run((c) => c.toggleFirstLineIndent())}
        >
          <IconArrowBarToRight />
        </ToggleButton>

        <Separator />
        <select
          aria-label="Espaçamento entre linhas"
          disabled={disabled}
          value={state?.lineSpacing == null ? "" : String(state.lineSpacing)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            run((c) => c.setLineSpacing(value === "" ? null : (Number(value) as LineSpacing)));
          }}
          className={cn(SELECT_CLASS, "w-[7.5rem]")}
        >
          <option value="">Espaçamento</option>
          {LINE_SPACINGS.map((spacing) => (
            <option key={spacing} value={String(spacing)}>
              {SPACING_LABEL[spacing]}
            </option>
          ))}
        </select>
        <IconAction label="Inserir quebra de página" disabled={disabled} onClick={() => run((c) => c.setPageBreak())}>
          <IconPageBreak />
        </IconAction>

        <Separator />
        <IconAction label="Desfazer" disabled={disabled || !state?.canUndo} onClick={() => run((c) => c.undo())}>
          <IconArrowBackUp />
        </IconAction>
        <IconAction label="Refazer" disabled={disabled || !state?.canRedo} onClick={() => run((c) => c.redo())}>
          <IconArrowForwardUp />
        </IconAction>

        <Button
          type="button"
          size="sm"
          variant={inserting ? "secondary" : "ghost"}
          disabled={disabled}
          aria-expanded={inserting}
          onClick={() => setInserting((open) => !open)}
          className="ml-auto"
        >
          <IconBraces data-icon="inline-start" aria-hidden="true" />
          Inserir campo
        </Button>
      </div>

      {inserting && editor !== null && (
        <InsertField
          existing={[...fields.keys()]}
          onInsert={(name) => {
            insertField(editor, name);
            setInserting(false);
          }}
          onCancel={() => {
            setInserting(false);
            editor.commands.focus();
          }}
        />
      )}
    </div>
  );
}

function insertField(editor: Editor, name: string) {
  editor.chain().focus().insertContent({ type: EDITOR_NODES.field, attrs: { name } }).run();
}

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />;
}

function ToggleButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the selection in the document: a button taking focus first would
      // leave the mark applied to nothing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn("max-md:size-10", active && "bg-muted text-foreground")}
    >
      {children}
    </Button>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="max-md:size-10"
    >
      {children}
    </Button>
  );
}

/**
 * Names a new field. The author types words, "Nome do locatário", and sees the
 * name the template will use, `nome_do_locatario`; typing a valid name directly
 * works the same way. Fields already in the document are one click away.
 */
function InsertField({
  existing,
  onInsert,
  onCancel,
}: {
  readonly existing: readonly string[];
  readonly onInsert: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const [typed, setTyped] = useState("");
  const name = toPlaceholderName(typed);
  const problem =
    typed.trim() === ""
      ? null
      : name === ""
        ? "Use letras ou números no nome."
        : name.length > MAX_PLACEHOLDER_NAME_LENGTH
          ? `O nome pode ter no máximo ${MAX_PLACEHOLDER_NAME_LENGTH} caracteres.`
          : !isValidPlaceholderName(name)
            ? "Esse nome não pode ser usado."
            : null;
  const ready = typed.trim() !== "" && problem === null;

  return (
    // Not a <form>: the editor sits inside the page's own form, and forms do
    // not nest. Enter submits by hand instead.
    <div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
      <label htmlFor={inputId} className="text-small font-medium leading-none">
        Nome do novo campo
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          autoFocus
          value={typed}
          aria-describedby={hintId}
          aria-invalid={problem !== null}
          placeholder="Nome do locatário"
          onChange={(event) => setTyped(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (ready) onInsert(name);
            }
          }}
          className="h-8 max-w-72 flex-1"
        />
        <Button type="button" size="sm" disabled={!ready} onClick={() => onInsert(name)}>
          <IconPlus data-icon="inline-start" aria-hidden="true" />
          Inserir
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
      <p id={hintId} aria-live="polite" className={cn("text-caption", problem ? "text-destructive" : "text-faint")}>
        {problem ??
          (ready ? (
            <>
              Entra no documento como <code className="font-mono text-docs">{placeholderSyntax(name)}</code>.
            </>
          ) : (
            "Escreva com palavras; o nome do campo é montado sem acentos e com _."
          ))}
      </p>
      {existing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-faint">Repetir um campo:</span>
          {existing.map((field) => (
            <button
              key={field}
              type="button"
              onClick={() => onInsert(field)}
              className="rounded-[4px] border border-docs/40 bg-docs/12 px-1.5 py-px font-mono text-xs text-docs-soft hover:bg-docs/20 focus-visible:ring-[3px] focus-visible:ring-ring/30"
            >
              {placeholderSyntax(field)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- fields panel ----------------------------------------------------

/**
 * Every field of the document, as the generation form will show them, with
 * how many times each appears. Renaming changes every occurrence at once, so
 * a field never ends up half renamed.
 */
function FieldsPanel({
  editor,
  blocks,
}: {
  readonly editor: Editor | null;
  readonly blocks: readonly Block[];
}) {
  const counts = useMemo(() => placeholdersIn(blocks), [blocks]);
  const groups = useMemo(() => groupPlaceholders([...counts.keys()]), [counts]);
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <aside aria-labelledby="campos-do-modelo" className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:sticky lg:top-0">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="campos-do-modelo" className="text-sm font-semibold">
          Campos
        </h2>
        <span className="text-caption text-faint">{counts.size}</span>
      </div>

      {counts.size === 0 ? (
        <p className="text-caption leading-relaxed text-muted-foreground">
          Nenhum campo ainda. Use “Inserir campo” onde o documento deve receber um valor, como o nome
          do locatário ou o valor do aluguel.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.key ?? "loose"} className="flex flex-col gap-1">
              {group.label !== null && (
                <span className="font-mono text-label uppercase tracking-[0.1em] text-faint">{group.label}</span>
              )}
              <ul className="flex flex-col gap-1">
                {group.fields.map((field) => (
                  <li key={field.name}>
                    {renaming === field.name && editor !== null ? (
                      <RenameField
                        name={field.name}
                        onRename={(next) => {
                          renameField(editor, field.name, next);
                          setRenaming(null);
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    ) : (
                      <div className="group flex items-center gap-1.5">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-small">{humanize(field.name)}</span>
                          <span className="block truncate font-mono text-xs text-docs-soft">
                            {placeholderSyntax(field.name)}
                            {(counts.get(field.name) ?? 0) > 1 && (
                              <span className="ml-1.5 font-sans text-faint">{counts.get(field.name)}×</span>
                            )}
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Inserir ${humanize(field.name)} no cursor`}
                          disabled={editor === null}
                          onClick={() => editor !== null && insertField(editor, field.name)}
                          className="max-md:size-10"
                        >
                          <IconPlus />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Renomear ${humanize(field.name)}`}
                          disabled={editor === null}
                          onClick={() => setRenaming(field.name)}
                          className="max-md:size-10"
                        >
                          <IconPencil />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function RenameField({
  name,
  onRename,
  onCancel,
}: {
  readonly name: string;
  readonly onRename: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [typed, setTyped] = useState(name);
  const next = toPlaceholderName(typed);
  const valid = isValidPlaceholderName(next);

  const submit = () => {
    if (!valid) return;
    if (next === name) onCancel();
    else onRename(next);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          aria-label={`Novo nome para ${humanize(name)}`}
          value={typed}
          aria-invalid={!valid}
          onChange={(event) => setTyped(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Confirmar" disabled={!valid} onClick={submit} className="max-md:size-10">
          <IconCheck />
        </Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancelar" onClick={onCancel} className="max-md:size-10">
          <IconX />
        </Button>
      </div>
      <span className="font-mono text-xs text-faint">{valid ? placeholderSyntax(next) : "Nome inválido"}</span>
    </div>
  );
}

/** Renames every occurrence in one step, so a single undo restores them all. */
function renameField(editor: Editor, from: string, to: string) {
  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      state.doc.descendants((node, position) => {
        if (node.type.name === EDITOR_NODES.field && node.attrs.name === from) {
          tr.setNodeMarkup(position, undefined, { ...node.attrs, name: to });
        }
      });
      return true;
    })
    .run();
}
