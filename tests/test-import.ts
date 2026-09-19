// 快速验证导入
import('../src/index.ts').then(m => console.log('OK:', m.name)).catch(e => console.error('FAIL:', e.message));
