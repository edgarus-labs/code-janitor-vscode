import { Node, TextEdit, applyEdits, findAll, parseCSharp } from '../parser';
import { SourceTransformation } from '../types';
import { delegateParameterTypes } from './editorConfigExpressionPreferences';
import { storedDelegateType } from './typeFacts';

const JSON_SERIALIZER_RECEIVERS = new Set([
  'JsonSerializer',
  'System.Text.Json.JsonSerializer',
  'global::System.Text.Json.JsonSerializer',
]);

const JSON_SERIALIZER_OPTIONS_TYPES = new Set([
  'JsonSerializerOptions',
  'System.Text.Json.JsonSerializerOptions',
  'global::System.Text.Json.JsonSerializerOptions',
]);

/**
 * Replaces direct `new JsonSerializerOptions()` arguments of `JsonSerializer.*` calls with
 * `default(JsonSerializerOptions)` (written with the type as the call names it), or with `null` for a
 * named `options:` argument (CA1869), avoiding a per-call allocation while keeping the selected
 * overload. Configured instances - those with an initializer or constructor arguments - are left alone.
 */
export const jsonSerializerOptionsReuseConverter: SourceTransformation = {
  name: 'CA1869 JsonSerializerOptions Reuse',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      for (const invocation of findAll(tree.rootNode, 'invocation_expression')) {
        if (!isJsonSerializerCall(invocation)) {
          continue;
        }

        const argumentList = invocation.childForFieldName('arguments');
        for (const argument of argumentList?.namedChildren ?? []) {
          if (argument?.type !== 'argument') {
            continue;
          }

          const expression = argumentExpression(argument);
          if (expression && isPlainOptionsCreation(expression)) {
            // A positional `null` is ambiguous with the `JsonTypeInfo<T>` and `JsonSerializerContext` overloads
            // (CS0121); a named `options:` argument only matches the options overloads.
            const named = argument.children.some((child) => child?.type === ':');
            const createdType = expression.childForFieldName('type')?.text ?? 'JsonSerializerOptions';
            edits.push({ start: expression.startIndex, end: expression.endIndex, text: named ? 'null' : `default(${createdType})` });
          }
        }
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function isJsonSerializerCall(invocation: Node): boolean {
  const target = invocation.childForFieldName('function');
  if (target?.type !== 'member_access_expression') {
    return false;
  }

  const receiver = target.childForFieldName('expression');

  return receiver !== null && JSON_SERIALIZER_RECEIVERS.has(receiver.text);
}

/** The expression of an argument: the last named child, after any `name:` label or `ref`/`out`. */
function argumentExpression(argument: Node): Node | undefined {
  const named = argument.namedChildren.filter((child): child is Node => Boolean(child));

  return named[named.length - 1];
}

function isPlainOptionsCreation(expression: Node): boolean {
  if (expression.type !== 'object_creation_expression') {
    return false;
  }

  if (expression.childForFieldName('initializer')) {
    return false;
  }

  const args = expression.childForFieldName('arguments');
  if (args && args.namedChildren.some((child) => child?.type === 'argument')) {
    return false;
  }

  const createdType = expression.childForFieldName('type')?.text;

  return createdType !== undefined && JSON_SERIALIZER_OPTIONS_TYPES.has(createdType);
}

/**
 * Simplifies a lambda or anonymous method whose block body holds exactly one statement into an
 * expression body: `() => { return Compute(); }` becomes `() => Compute()`.
 */
export const singleStatementLambdaConverter: SourceTransformation = {
  name: 'Single Statement Lambda',
  apply(source: string): string {
    if (!source) {
      return source;
    }

    const tree = parseCSharp(source);

    try {
      const edits: TextEdit[] = [];

      // A block body cannot become an expression tree and `{ F(); }` discards F's value, so as an
      // argument the expression body can bind to another overload (`Expression<T>`, `Func<Task>`).
      // Only lambdas that initialize a variable of a written delegate type are rewritten
      // (https://learn.microsoft.com/dotnet/csharp/language-reference/operators/lambda-expressions#expression-lambdas).
      for (const lambda of findAll(tree.rootNode, 'lambda_expression')) {
        const body = lambda.childForFieldName('body');
        const expression = singleExpressionOfBlock(body);
        if (body && expression && storedDelegateType(lambda)) {
          edits.push({ start: body.startIndex, end: body.endIndex, text: expression.text });
        }
      }

      for (const anonymous of findAll(tree.rootNode, 'anonymous_method_expression')) {
        const body = anonymous.namedChildren.find((child) => child?.type === 'block');
        const expression = singleExpressionOfBlock(body);
        const delegateType = storedDelegateType(anonymous);
        const parameters = anonymous.childForFieldName('parameters');
        // `delegate { }` without a parameter list converts to a delegate with any parameters; `() =>`
        // only to one without (https://learn.microsoft.com/dotnet/csharp/language-reference/operators/delegate-operator).
        if (!expression || !delegateType || (!parameters && delegateParameterTypes(delegateType)?.length !== 0)) {
          continue;
        }

        const isAsync = anonymous.children.some((child) => child?.type === 'async');
        const prefix = isAsync ? 'async ' : '';

        edits.push({
          start: anonymous.startIndex,
          end: anonymous.endIndex,
          text: `${prefix}${parameters?.text ?? '()'} => ${expression.text}`,
        });
      }

      return applyEdits(source, edits);
    } finally {
      tree.delete();
    }
  },
};

function singleExpressionOfBlock(block: Node | null | undefined): Node | undefined {
  if (!block || block.type !== 'block') {
    return undefined;
  }

  const statements = block.namedChildren.filter(
    (child): child is Node => Boolean(child) && child!.type !== 'comment' && !child!.type.startsWith('preproc')
  );

  if (statements.length !== 1) {
    return undefined;
  }

  const statement = statements[0];

  if (statement.type === 'expression_statement') {
    return statement.namedChild(0) ?? undefined;
  }

  if (statement.type === 'return_statement') {
    return statement.namedChild(0) ?? undefined;
  }

  return undefined;
}
