import * as vm from "vm";
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  // Создаём контроллер для выполнения ячеек
  const controller = vscode.notebooks.createNotebookController(
    "js-transform-kernel",
    "js-transform-notebook",
    "JS Transform Kernel"
  );

  controller.supportedLanguages = ["javascript"];
  controller.supportsExecutionOrder = false;

  const LANGUAGE_ID_TO_MIME: Record<string, string> = {
    javascript: "text/javascript",
    typescript: "text/typescript",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    xml: "application/xml",
    markdown: "text/markdown",
    plaintext: "text/plain",
    text: "text/plain",
    python: "text/x-python",
    sql: "text/x-sql",
    go: "text/go",
    // добавь другие по мере необходимости
  };

  function getMimeType(languageId: string): string {
    return LANGUAGE_ID_TO_MIME[languageId] || "text/plain";
  }

  // Обработчик выполнения
  controller.executeHandler = async (cells, notebook, _controller) => {
    // Находим входной текст: ищем первую ячейку с languageId === 'plaintext'
    let inputText = "";
    let inputLanguageId = "plaintext";
    let inputFound = false;

    let codeCell: vscode.NotebookCell | undefined;

    for (let i = 0; i < notebook.cellCount; i++) {
      const candidate = notebook.cellAt(i);
      if (!inputFound && candidate.kind === vscode.NotebookCellKind.Code) {
        inputText = candidate.document.getText();
        inputLanguageId = candidate.document.languageId;
        inputFound = true;
        continue;
      }
      if (
        inputFound &&
        candidate.kind === vscode.NotebookCellKind.Code &&
        candidate.document.languageId === "javascript"
      ) {
        codeCell = candidate;
        break;
      }
    }
    if (!codeCell) {
      return;
    }

    const execution = controller.createNotebookCellExecution(codeCell);
    execution.start();

    try {
      const code = codeCell.document.getText();
      const output = await runUserScript(code, inputText);

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(
            output,
            getMimeType(inputLanguageId)
          ),
        ]),
      ]);
      execution.end(true);
    } catch (err: any) {
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error({
            name: "TransformError",
            message: err.message || String(err),
          }),
        ]),
      ]);
      execution.end(false);
    }
  };

  context.subscriptions.push(controller);

  // Команда: открыть ноутбук
  const openCmd = vscode.commands.registerCommand(
    "js-transform-notebook.open",
    async () => {
      const editor = vscode.window.activeTextEditor;
      let inputText =
        editor?.document.getText(
          editor.selection.isEmpty ? undefined : editor.selection
        ) || "";

      const notebook = new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          "## Input\nYour selected text or file content.",
          "markdown"
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          inputText,
          editor?.document.languageId ?? "plaintext"
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          "## Transform\nWrite JS that returns a string from `input`.",
          "markdown"
        ),
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "input.toUpperCase()",
          "javascript"
        ),
      ]);

      const doc = await vscode.workspace.openNotebookDocument(
        "js-transform-notebook",
        notebook
      );
      await vscode.window.showNotebookDocument(doc);
    }
  );

  context.subscriptions.push(openCmd);
  // Регистрируем сериализатор (обязательно!)
  const serializer: vscode.NotebookSerializer = {
    async deserializeNotebook(
      content: Uint8Array
    ): Promise<vscode.NotebookData> {
      // Если файл пустой — создаём пустой ноутбук
      if (content.length === 0) {
        return new vscode.NotebookData([]);
      }
      const str = new TextDecoder().decode(content);
      try {
        const json = JSON.parse(str);
        return new vscode.NotebookData(
          json.cells.map(
            (cell: any) =>
              new vscode.NotebookCellData(
                cell.kind,
                cell.value,
                cell.languageId
              )
          )
        );
      } catch (e) {
        // Если не JSON — создаём одну markdown-ячейку
        return new vscode.NotebookData([
          new vscode.NotebookCellData(
            vscode.NotebookCellKind.Markup,
            "# Invalid or empty notebook",
            "markdown"
          ),
        ]);
      }
    },

    async serializeNotebook(data: vscode.NotebookData): Promise<Uint8Array> {
      const json = {
        cells: data.cells.map((cell) => ({
          kind: cell.kind,
          value: cell.value,
          languageId: cell.languageId,
        })),
      };
      return new TextEncoder().encode(JSON.stringify(json));
    },
  };

  // Регистрируем сериализатор
  const disposableSerializer = vscode.workspace.registerNotebookSerializer(
    "js-transform-notebook",
    serializer
  );
  context.subscriptions.push(disposableSerializer);
}
function addReturnToLastLine(code: string): string {
  const lines = code.split('\n');
  
  // Найдём последнюю непустую строку, игнорируя комментарии в конце
  let lastExprIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    // Пропускаем пустые строки и комментарии
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      continue;
    }
    lastExprIndex = i;
    break;
  }

  if (lastExprIndex === -1) {
    return code;
  }

  const lastLine = lines[lastExprIndex].trim();

  // Не добавляем return, если:
  // - уже есть return
  // - это объявление
  // - заканчивается на ; или }
  // - начинается с { (блок)
  if (
    /^\s*return\b/.test(lastLine) ||
    /^(function|class|let|const|var|if|for|while|do|switch|try|import|export|async\s+function)\b/.test(lastLine) ||
    lastLine.endsWith(';') ||
    lastLine.endsWith('}') ||
    lastLine.startsWith('{')
  ) {
    return code;
  }

  // Также не добавляем, если строка выглядит как объявление стрелочной функции
  if (/=\s*\(.*\)\s*=>/.test(lastLine) || /=\s*[^=]+=>/.test(lastLine)) {
    return code;
  }

  // Добавляем return к последней строке
  lines[lastExprIndex] = lines[lastExprIndex].replace(
    /\S.*$/,
    match => `return (${match});`
  );

  return lines.join('\n');
}

async function runUserScript(code: string, input: string): Promise<string> {
  code = addReturnToLastLine(code);

  const wrapped = `(async (input) => { ${code} })(input)`;

  const sandbox = vm.createContext({
    input,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: {
      log: (...args: any[]) => console.log("[User Script]", ...args),
      error: (...args: any[]) => console.error("[User Script]", ...args),
    },
  });

  try {
    const script = new vm.Script(wrapped);
    const promise = script.runInContext(sandbox, { timeout: 2000 });

    // Теперь дожидаемся результата!
    const result = await promise;

    return typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2);
  } catch (e) {
    throw e;
  }
}
