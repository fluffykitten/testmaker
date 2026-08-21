import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './ExamMathText.css';

interface ExamMathTextProps {
  content: string;
  className?: string;
}

const KATEX_OPTIONS = {
  throwOnError: false,
  trust: true,
  strict: false,
  macros: {
    '\\degree': '^\\circ',
    '\\degreeC': '^\\circ\\text{C}',
    '\\celsius': '^\\circ\\text{C}',
    '\\ce': '#1',
  },
};

/**
 * Renders inline/block math and text for a single cell or line
 */
function renderMathSnippet(snippet: string): React.ReactNode {
  if (!snippet) return null;

  // Split by block math $$...$$ and inline math $...$
  const tokens = snippet.split(/(\$\$[\s\S]*?\$\$|\$(?!\$)[^\$\n]+?\$)/g);

  return tokens.map((token, idx) => {
    if (!token) return null;

    // Block Math: $$ ... $$
    if (token.startsWith('$$') && token.endsWith('$$') && token.length >= 4) {
      const math = token.slice(2, -2).trim();
      try {
        const html = katex.renderToString(math, {
          ...KATEX_OPTIONS,
          displayMode: true,
        });
        return (
          <span
            key={idx}
            className="exam-math-block"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <span key={idx} className="exam-math-block exam-math-fallback">
            {token}
          </span>
        );
      }
    }

    // Inline Math: $ ... $
    if (token.startsWith('$') && token.endsWith('$') && token.length >= 2) {
      const math = token.slice(1, -1).trim();
      try {
        const html = katex.renderToString(math, {
          ...KATEX_OPTIONS,
          displayMode: false,
        });
        return (
          <span
            key={idx}
            className="exam-math-inline"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <span key={idx} className="exam-math-inline exam-math-fallback">
            {token}
          </span>
        );
      }
    }

    return <React.Fragment key={idx}>{token}</React.Fragment>;
  });
}

/**
 * Parses markdown table blocks and mixed text/KaTeX
 */
export const ExamMathText: React.FC<ExamMathTextProps> = ({ content, className = '' }) => {
  if (!content) return null;

  // Normalize string: convert literal '\n' string to actual newline
  const normalized = content.replace(/\\n/g, '\n');

  // Split by markdown table patterns (lines beginning with |)
  const lines = normalized.split('\n');
  const blocks: { type: 'text' | 'table'; lines: string[] }[] = [];
  let currentBlock: { type: 'text' | 'table'; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.trim().startsWith('|') && line.trim().endsWith('|');

    if (isTableLine) {
      if (!currentBlock || currentBlock.type !== 'table') {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: 'table', lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
    } else {
      if (!currentBlock || currentBlock.type !== 'text') {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: 'text', lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  return (
    <div className={`exam-math-wrapper ${className}`}>
      {blocks.map((block, bIdx) => {
        if (block.type === 'table') {
          // Parse Markdown Table
          const rawRows = block.lines
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !/^\|[-:\s|]+\|$/.test(l)); // Filter out separator rows like |---|---|

          if (rawRows.length === 0) return null;

          const headerCells = rawRows[0]
            .slice(1, -1)
            .split('|')
            .map((c) => c.trim());

          const bodyRows = rawRows.slice(1).map((rowStr) =>
            rowStr
              .slice(1, -1)
              .split('|')
              .map((c) => c.trim())
          );

          return (
            <div key={bIdx} className="exam-table-container">
              <table className="exam-markdown-table">
                <thead>
                  <tr>
                    {headerCells.map((h, hi) => (
                      <th key={hi}>{renderMathSnippet(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{renderMathSnippet(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // Text Block with linebreaks and math
        return (
          <div key={bIdx} className="exam-text-block">
            {block.lines.map((line, li) => (
              <React.Fragment key={li}>
                {renderMathSnippet(line)}
                {li < block.lines.length - 1 && <br />}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
};
