// 简单的工具函数集合

/**
 * 计算两个数的和
 * @param {number} a - 第一个数
 * @param {number} b - 第二个数
 * @returns {number} 和
 */
function add(a, b) {
  return a + b;
}

/**
 * 问候函数
 * @param {string} name - 姓名
 * @returns {string} 问候语
 */
function greet(name) {
  return `你好，${name}！`;
}

/**
 * 检查数字是否为偶数
 * @param {number} num - 要检查的数字
 * @returns {boolean} 是否为偶数
 */
function isEven(num) {
  return num % 2 === 0;
}

// 导出函数
module.exports = {
  add,
  greet,
  isEven
};
