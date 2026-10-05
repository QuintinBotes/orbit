import { describe, expect, it } from 'vitest';
import { decodeAnsiC, parseShell, type ParseResult, type SimpleCommand } from '../../../src/policy/shell.ts';

function parse(src: string): SimpleCommand[] {
  const r = parseShell(src);
  if (!r.ok) throw new Error(`expected a clean parse of ${JSON.stringify(src)}, got: ${r.error}`);
  return r.commands;
}
function failure(src: string): Extract<ParseResult, { ok: false }> {
  const r = parseShell(src);
  if (r.ok) throw new Error(`expected a parse failure for ${JSON.stringify(src)}`);
  return r;
}
const texts = (src: string, cmd = 0): string[] => parse(src)[cmd]!.words.map((w) => w.text);
const redirects = (src: string) => parse(src)[0]!.redirects.map((r) => `${r.fd ?? ''}${r.op}${r.target?.text ?? ''}`);

describe('parseShell refuses what it cannot judge', () => {
  it('oversized input and NUL bytes', () => {
    expect(failure('a'.repeat(100_001)).error).toBe('command is too long to inspect');
    expect(failure('a'.repeat(100_001)).commands).toEqual([]);
    expect(failure('a\0b').error).toBe('command contains a NUL byte');
    expect(parseShell('a'.repeat(100_000)).ok).toBe(true);
  });

  it('unterminated quotes and substitutions, and a trailing backslash', () => {
    expect(failure('a\\').error).toBe('trailing backslash');
    expect(failure("a 'x").error).toBe('unterminated single quote');
    expect(failure('a "x').error).toBe('unterminated double quote');
    expect(failure("a $'x").error).toBe("unterminated $'...' string");
    expect(failure('a $(x').error).toBe('unterminated $( or (');
    expect(failure('a ${x').error).toBe('unterminated ${');
    expect(failure('a `x').error).toBe('unterminated backtick');
    expect(failure('a $(echo "x)').error).toBe('unterminated double quote');
    expect(failure("a $(echo 'x)").error).toBe('unterminated single quote');
    expect(failure("a ${x:-'y}").error).toBe('unterminated single quote');
    expect(failure('a ${x:-"y}').error).toBe('unterminated double quote');
  });

  it('structure errors: pipes, parentheses, redirections without targets', () => {
    expect(failure('| a').error).toBe('pipe without a command');
    expect(failure('a | | b').error).toBe('pipe without a command');
    expect(failure('(a; b) | c').error).toBe('pipe without a command');
    expect(failure('a (b)').error).toMatch(/^unsupported syntax: "\(" after a word/);
    expect(failure('x=1 (b)').error).toMatch(/^unsupported syntax/);
    expect(failure(') a').error).toBe('unbalanced ")" (case statements are not supported)');
    expect(failure('( a').error).toBe('unclosed "("');
    for (const src of ['a >', 'a > > f', 'a > ;', 'a > &&']) expect(failure(src).error).toBe('redirection without a target');
  });

  it('keeps the commands parsed before the failure', () => {
    const r = failure('one; two | | three');
    expect(r.commands.map((c) => c.words[0]!.text)).toEqual(['one', 'two']);
  });
});

describe('lexing operators', () => {
  it('splits on ; && || & newline and reads |& as a pipe', () => {
    const c = parse('a && b || c; d\ne & f |& g');
    expect(c.map((x) => `${x.words[0]!.text}:${x.pipeline}.${x.stage}${x.background ? '&' : ''}`)).toEqual(['a:0.0', 'b:1.0', 'c:2.0', 'd:3.0', 'e:4.0&', 'f:5.0', 'g:5.1']);
  });

  it('treats case terminators ;; ;& ;;& as plain separators and skips comments and line continuations', () => {
    expect(parse('a ;; b ;& c').map((x) => x.words[0]!.text)).toEqual(['a', 'b', 'c']);
    expect(texts('ls # a comment\nwc', 1)).toEqual(['wc']);
    expect(texts('ls \\\n -l')).toEqual(['ls', '-l']);
    expect(texts('ls -\\\nl')).toEqual(['ls', '-l']);
  });

  it('a trailing pipe is accepted', () => {
    expect(parse('a |')).toHaveLength(1);
  });
});

describe('redirections', () => {
  it('reads every operator, with and without a file descriptor', () => {
    expect(redirects('a &>> f')).toEqual(['&>>f']);
    expect(redirects('a &> f')).toEqual(['&>f']);
    expect(redirects('a 2>&1')).toEqual(['2>&1']);
    expect(redirects('a 2>f')).toEqual(['2>f']);
    expect(redirects('a 12>f')).toEqual(['12>f']);
    expect(redirects('a <<<"x"')).toEqual(['<<<x']);
    expect(redirects('a <>f')).toEqual(['<>f']);
    expect(redirects('a >|f')).toEqual(['>|f']);
    expect(redirects('a >>f')).toEqual(['>>f']);
    expect(redirects('a <&3')).toEqual(['<&3']);
    expect(redirects('a < in > out')).toEqual(['<in', '>out']);
  });

  it('a digit run not touching an operator stays a word', () => {
    expect(texts('echo 2 > f')).toEqual(['echo', '2']);
  });

  it('records one redirection per brace expansion of the target', () => {
    expect(redirects('a > f{1,2}')).toEqual(['>f1', '>f2']);
  });

  it('process substitutions are words that keep their source', () => {
    const [cmd] = parse('cat <(ls) >(wc)');
    expect(cmd!.words.map((w) => [w.text, w.procSub, w.dynamic, w.subs])).toEqual([
      ['cat', false, false, []],
      ['<(ls)', true, true, ['ls']],
      ['>(wc)', true, true, ['wc']],
    ]);
  });

  it('inside [[ ]] the angle brackets compare strings', () => {
    const [cmd] = parse('[[ a < b ]] > out');
    expect(cmd!.words.map((w) => w.text)).toEqual(['[[', 'a', '<', 'b', ']]']);
    expect(cmd!.redirects.map((r) => `${r.op}${r.target!.text}`)).toEqual(['>out']);
  });
});

describe('here-documents', () => {
  it('cuts the body, strips leading tabs for <<-, and keeps every body for several documents', () => {
    expect(parse('a <<-EOF\n\tx\n\ty\n\tEOF\nb')[0]!.redirects[0]!.heredoc).toEqual({ body: '\tx\n\ty', quoted: false, subs: [] });
    const [first] = parse('a <<A <<B\none\nA\ntwo\nB\n');
    expect(first!.redirects.map((r) => r.heredoc!.body)).toEqual(['one', 'two']);
    expect(parse('a <<EOF').at(0)!.redirects[0]!.heredoc!.body).toBe('');
  });

  it('finds substitutions only in an unquoted delimiter body', () => {
    const open = parse('a <<EOF\n$(cmd)\n`cmd2`\nEOF\n')[0]!.redirects[0]!.heredoc!;
    expect(open.subs).toEqual(['cmd', 'cmd2']);
    const quoted = parse("a <<'EOF'\n$(cmd)\nEOF\n")[0]!.redirects[0]!.heredoc!;
    expect(quoted).toEqual({ body: '$(cmd)', quoted: true, subs: [] });
  });

  it('records what it can from an unbalanced substitution in the body and ignores escaped ones', () => {
    expect(parse('a <<EOF\n$(unbalanced\nEOF\n')[0]!.redirects[0]!.heredoc!.subs).toEqual(['unbalanced']);
    expect(parse('a <<EOF\n`unbalanced\nEOF\n')[0]!.redirects[0]!.heredoc!.subs).toEqual(['unbalanced']);
    expect(parse('a <<EOF\n\\$(x) $((1))\nEOF\n')[0]!.redirects[0]!.heredoc!.subs).toEqual([]);
  });
});

describe('words and expansions', () => {
  it('applies backslash and quote rules and marks quoted words', () => {
    const [cmd] = parse('a\\ b "x\\"y" "\\$x \\q" \'lit\'');
    expect(cmd!.words.map((w) => [w.text, w.quoted])).toEqual([
      ['a b', true],
      ['x"y', true],
      ['$x \\q', true],
      ['lit', true],
    ]);
  });

  it('marks run-time values dynamic and keeps nested sources', () => {
    const [cmd] = parse('a $VAR ${VAR} $((1+2)) $(cmd) `cmd` "q $x"');
    const [, ...rest] = cmd!.words;
    expect(rest.map((w) => [w.text, w.dynamic, w.subs])).toEqual([
      ['$VAR', true, []],
      ['${VAR}', true, []],
      ['$((1+2))', true, []],
      ['$(cmd)', true, ['cmd']],
      ['`cmd`', true, ['cmd']],
      ['q $x', true, []],
    ]);
  });

  it('special parameters are dynamic; a lone or trailing $ is literal text', () => {
    const [cmd] = parse('a $1 $@ $* $# $? $$ $! $-');
    expect(cmd!.words.slice(1).every((w) => w.dynamic)).toBe(true);
    expect(texts('a $ b')).toEqual(['a', '$', 'b']);
    expect(texts('a b$')).toEqual(['a', 'b$']);
    expect(parse('a b$')[0]!.words[1]!.dynamic).toBe(false);
  });

  it('decodes $\'...\' escapes and treats $"..." as a quoted string', () => {
    const [cmd] = parse('a $\'x\\ty\' $\'\\x67it\' $"q $x"');
    expect(cmd!.words.slice(1).map((w) => [w.text, w.dynamic, w.quoted])).toEqual([
      ['x\ty', false, true],
      ['git', false, true],
      ['q $x', true, true],
    ]);
  });

  it('finds substitutions through nested quotes, backticks and braces', () => {
    expect(parse('a $(echo ")")')[0]!.words[1]!.subs).toEqual(['echo ")"']);
    expect(parse('a $(echo `x`)')[0]!.words[1]!.subs).toEqual(['echo `x`']);
    expect(parse('a $(echo "a)b")')[0]!.words[1]!.subs).toEqual(['echo "a)b"']);
    expect(parse("a $(echo 'a)b')")[0]!.words[1]!.subs).toEqual(["echo 'a)b'"]);
    expect(parse('a $(echo "$(inner)")')[0]!.words[1]!.subs).toEqual(['echo "$(inner)"']);
    expect(parse('a $(a \\) b)')[0]!.words[1]!.subs).toEqual(['a \\) b']);
    expect(parse('a ${x:-"}"}')[0]!.words[1]!.text).toBe('${x:-"}"}');
    expect(parse("a ${x:-'}'}")[0]!.words[1]!.text).toBe("${x:-'}'}");
    expect(parse('a ${x:-\\}}')[0]!.words[1]!.text).toBe('${x:-\\}}');
    expect(parse('a ${x:-$(y)}')[0]!.words[1]!.subs).toEqual(['y']);
    expect(parse('a ${x:-`y`}')[0]!.words[1]!.subs).toEqual(['y']);
    expect(parse('a ${x:-{b}}')[0]!.words[1]!.text).toBe('${x:-{b}}');
    expect(parse('a $((1+$(b)))')[0]!.words[1]!.subs).toEqual(['b']);
    expect(parse('a ${x:-$((1+2))}')[0]!.words[1]!.subs).toEqual([]);
    expect(parse('a "$(b "c")"')[0]!.words[1]!.subs).toEqual(['b "c"']);
    expect(parse('a "x`y`"')[0]!.words[1]!.subs).toEqual(['y']);
    expect(parse('a `b \\`c\\``')[0]!.words[1]!.subs).toEqual(['b `c`']);
  });
});

describe('assignments', () => {
  it('only leading NAME=value words are assignments; a quoted value stays attached', () => {
    const [cmd] = parse('x=1 y="a b" z+=2 a[1]=3 cmd k=v');
    expect(cmd!.assigns.map((w) => w.raw)).toEqual(['x=1', 'y="a b"', 'z+=2', 'a[1]=3']);
    expect(cmd!.words.map((w) => w.text)).toEqual(['cmd', 'k=v']);
    expect(parse('x=$(y) cmd')[0]!.assigns[0]!.subs).toEqual(['y']);
  });

  it('assignments are not brace-expanded', () => {
    expect(parse('x={a,b} cmd')[0]!.assigns.map((w) => w.text)).toEqual(['x={a,b}']);
  });
});

describe('subshells', () => {
  it('numbers each parenthesised group and nests scopes outermost first', () => {
    const c = parse('(a; (b)); (c)');
    expect(c.map((x) => [x.words[0]!.text, x.scope])).toEqual([
      ['a', [1]],
      ['b', [1, 2]],
      ['c', [3]],
    ]);
  });
});

describe('brace expansion', () => {
  it('expands comma lists, nested lists and products', () => {
    expect(texts('echo {a,b}c')).toEqual(['echo', 'ac', 'bc']);
    expect(texts('echo {a,{b,c}}')).toEqual(['echo', 'a', 'b', 'c']);
    expect(texts('echo {a,b}{c,d}')).toEqual(['echo', 'ac', 'ad', 'bc', 'bd']);
    expect(texts('echo {,a}')).toEqual(['echo', '', 'a']);
    expect(texts('echo a{b,c}d{e,f}')).toEqual(['echo', 'abde', 'abdf', 'acde', 'acdf']);
  });

  it('expands numeric and character sequences with steps, padding and direction', () => {
    expect(texts('echo {1..3}')).toEqual(['echo', '1', '2', '3']);
    expect(texts('echo {3..1}')).toEqual(['echo', '3', '2', '1']);
    expect(texts('echo {01..03}')).toEqual(['echo', '01', '02', '03']);
    expect(texts('echo {1..10..3}')).toEqual(['echo', '1', '4', '7', '10']);
    expect(texts('echo {-2..2}')).toEqual(['echo', '-2', '-1', '0', '1', '2']);
    expect(texts('echo {-01..01}')).toEqual(['echo', '-01', '000', '001']);
    expect(texts('echo {1..3..-1}')).toEqual(['echo', '1', '2', '3']);
    expect(texts('echo {a..e}')).toEqual(['echo', 'a', 'b', 'c', 'd', 'e']);
    expect(texts('echo {e..a..2}')).toEqual(['echo', 'e', 'c', 'a']);
    expect(texts('echo {a..c..0}')).toEqual(['echo', 'a', 'b', 'c']);
  });

  it('leaves quoted, escaped, unbalanced and single-element groups alone', () => {
    expect(texts("echo '{a,b}'")).toEqual(['echo', '{a,b}']);
    expect(texts('echo \\{a,b\\}')).toEqual(['echo', '{a,b}']);
    expect(texts('echo {a}')).toEqual(['echo', '{a}']);
    expect(texts('echo {a,b')).toEqual(['echo', '{a,b']);
    expect(texts('echo a{b')).toEqual(['echo', 'a{b']);
    expect(texts('echo "a{b,c}"d{e,f}')).toEqual(['echo', 'a{b,c}de', 'a{b,c}df']);
  });

  it('carries glob and dynamic flags to the expansion, and substitutions to the first alternative only', () => {
    const globs = parse('echo {a,b}*')[0]!.words.slice(1);
    expect(globs.map((w) => [w.text, w.glob])).toEqual([
      ['a*', true],
      ['b*', true],
    ]);
    const subs = parse('echo $(a){b,c}')[0]!.words.slice(1);
    expect(subs.map((w) => [w.text, w.dynamic, w.subs])).toEqual([
      ['$(a)b', true, ['a']],
      ['$(a)c', true, []],
    ]);
  });

  it('treats a word whose expansion is too large or too deep as computed at run time', () => {
    const big = parse('echo {1..1000}')[0]!.words[1]!;
    expect(big).toMatchObject({ text: '{1..1000}', dynamic: true });
    const many = parse(`echo ${'{a,b}'.repeat(40)}`)[0]!.words[1]!;
    expect(many.dynamic).toBe(true);
    const wide = parse('echo {a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}{a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p}{a,b,c}')[0]!.words[1]!;
    expect(wide.dynamic).toBe(true);
    const deep = parse(`echo ${'{1..1}'.repeat(40)}`)[0]!.words[1]!;
    expect(deep.dynamic).toBe(true);
  });
});

describe('decodeAnsiC', () => {
  it('decodes simple, octal, hex, unicode and control escapes', () => {
    expect(decodeAnsiC('\\a\\b\\e\\E\\f\\n\\r\\t\\v\\\\\\\'\\"\\?')).toBe('\x07\b\x1b\x1b\f\n\r\t\v\\\'"?');
    expect(decodeAnsiC('\\x41\\x4')).toBe('A\x04');
    expect(decodeAnsiC('\\u00e9\\U0001F600')).toBe('\u00e9\u{1F600}');
    expect(decodeAnsiC('\\101\\60\\7')).toBe('A0\x07');
    expect(decodeAnsiC('\\cA\\c?\\ca')).toBe('\x01\x7f\x01');
  });

  it('keeps an unrecognised or incomplete escape as written', () => {
    expect(decodeAnsiC('\\q')).toBe('\\q');
    expect(decodeAnsiC('\\xZ')).toBe('\\xZ');
    expect(decodeAnsiC('\\u')).toBe('\\u');
    expect(decodeAnsiC('\\c')).toBe('\\c');
    expect(decodeAnsiC('a\\')).toBe('a\\');
    expect(decodeAnsiC('plain')).toBe('plain');
  });

  it('ends the value at the first NUL and drops code points beyond Unicode', () => {
    expect(decodeAnsiC('ok\\x00after')).toBe('ok');
    expect(decodeAnsiC('ok\\0after')).toBe('ok');
    expect(decodeAnsiC('ok\\u0000x')).toBe('ok');
    expect(decodeAnsiC('ok\\400x')).toBe('ok');
    expect(decodeAnsiC('a\\U110000z')).toBe('az');
  });
});
