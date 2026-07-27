import { writeFileSync } from 'fs';
import { join } from 'path';
import { getLabelData } from '../labelDataUtils';
import { query } from '../db/clickhouse';
import getConfig from '../config';
import { getLogger } from '../utils';

/**
 * 导出 OpenDigger 中的地理标签为 countries.json。
 *
 * 地理标签为两级结构：
 *   - Division-0：国家（identifier 形如 :divisions/CN）
 *   - Division-1：省/州级行政区（identifier 形如 :divisions/CN/CN-BJ）
 *
 * 产物写入 OpenDigger 数据根目录（config.export.path）下的 countries.json，
 * 结构为：
 *   {
 *     exportTime: 导出时间（ISO 字符串）,
 *     countries: [
 *       {
 *         id: 标签 identifier,
 *         alpha2: 国家 alpha-2 编码,
 *         name / name_zh / name_full,
 *         type: 'Division-0',
 *         subdivisions: [
 *           {
 *             id, alpha2, name, name_zh, type: 'Division-1', category,
 *             cities: [ { name_zh } ]  // 仅中国各省有，取自 user_info，无 ID 与英文名
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * 国家 / 省州字段均取自标签的元数据（meta）及标签自身的 name / name_zh / type；
 * 省州下的 cities 字段来自 user_info 表按 province_id 聚合的地级市中文名。
 */

const logger = getLogger('exportCountries');

interface CityItem {
  name_zh: string;
}

interface SubdivisionItem {
  id: string;
  alpha2: string;
  name: string;
  name_zh?: string;
  type: string;
  category?: string;
  cities?: CityItem[];
}

interface CountryItem {
  id: string;
  alpha2: string;
  name: string;
  name_zh?: string;
  name_full?: string;
  type: string;
  subdivisions: SubdivisionItem[];
}

(async () => {
  const config: any = await getConfig();
  const outputDir: string = config.export.path;
  if (!outputDir) {
    throw new Error('config.export.path is not configured, can not determine data root directory.');
  }

  const labels = getLabelData();
  // 建立 identifier -> 标签 的索引，便于按国家的 children 查询下属省/州级标签
  const labelMap = new Map(labels.map(l => [l.identifier, l]));

  // 查询中国各省的地级市（仅中文名，无 ID 与英文名），按 province_id 聚合。
  // province_id 与标签 identifier 一致（形如 :divisions/CN/CN-BJ），排除含英文字母的脏数据。
  const cityRows = await query(`
SELECT city, any(province_id) AS province_id
FROM user_info
WHERE country = 'China' AND city != '' AND NOT match(city, '[a-zA-Z]')
GROUP BY city
  `);
  // province identifier -> 地级市中文名列表
  const provinceCityMap = new Map<string, string[]>();
  cityRows.forEach(row => {
    const city = row[0];
    const provinceId = row[1];
    if (!provinceId) return;
    if (!provinceCityMap.has(provinceId)) provinceCityMap.set(provinceId, []);
    provinceCityMap.get(provinceId)!.push(city);
  });

  const countries: CountryItem[] = labels
    .filter(l => l.type === 'Division-0')
    .map(country => {
      const subdivisions: SubdivisionItem[] = country.children
        .map(childId => labelMap.get(childId))
        .filter((child): child is NonNullable<typeof child> => !!child && child.type === 'Division-1')
        .map(child => {
          const cityNames = provinceCityMap.get(child.identifier);
          return {
            id: child.identifier,
            alpha2: child.meta?.alpha2,
            name: child.name,
            name_zh: child.name_zh,
            type: child.type,
            category: child.meta?.category,
            ...(cityNames && cityNames.length
              ? { cities: cityNames.sort((a, b) => a.localeCompare(b, 'zh')).map(name_zh => ({ name_zh })) }
              : {}),
          };
        })
        .sort((a, b) => (a.alpha2 ?? '').localeCompare(b.alpha2 ?? ''));

      return {
        id: country.identifier,
        alpha2: country.meta?.alpha2,
        name: country.name,
        name_zh: country.name_zh,
        name_full: country.meta?.name_full,
        type: country.type,
        subdivisions,
      };
    })
    .sort((a, b) => (a.alpha2 ?? '').localeCompare(b.alpha2 ?? ''));

  const result = {
    exportTime: new Date().toISOString(),
    countries,
  };

  const outputPath = join(outputDir, 'countries.json');
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  logger.info(`Exported ${countries.length} countries with ${countries.reduce((s, c) => s + c.subdivisions.length, 0)} subdivisions to ${outputPath}`);
})();
