"""Normalize DeepSeek exports without retaining user IDs or API key fragments."""
import csv, json, sys, hashlib
from decimal import Decimal
from pathlib import Path

def normalize(amount_file, cost_file):
    amount = list(csv.DictReader(Path(amount_file).open(encoding='utf-8-sig', newline='')))
    costs = list(csv.DictReader(Path(cost_file).open(encoding='utf-8-sig', newline='')))
    if not amount or not costs:
        raise ValueError('Empty export')
    if {r['api_key_name'] for r in amount} != {'qqbot'}:
        raise ValueError('Expected only qqbot API key usage')
    groups = {}
    types = {'request_count', 'input_cache_hit_tokens', 'input_cache_miss_tokens', 'output_tokens', 'function_call'}
    for r in amount:
        if r['type'] not in types: raise ValueError('Unknown usage type')
        n = Decimal(r['amount'])
        if n < 0 or n != int(n): raise ValueError('Invalid token count')
        if r['model'] and r['model'] not in {'deepseek-flash', 'deepseek-v4-pro'}: raise ValueError('Unknown model')
        key = (r['start_time_iso'], r['end_time_iso'], r['model'] or r['name'])
        item = groups.setdefault(key, dict(start=r['start_time_iso'], end=r['end_time_iso'], model=r['model'], name=r['name'], counts={}, calculatedCost='0'))
        item['counts'][r['type']] = item['counts'].get(r['type'], 0) + int(n)
        if r['price']:
            item['calculatedCost'] = str(Decimal(item['calculatedCost']) + n * Decimal(r['price']))
    bills = {}
    for r in costs:
        if r['currency'] != 'CNY' or Decimal(r['cost']) < 0: raise ValueError('Invalid currency or cost')
        key = (r['start_time_iso'], r['end_time_iso'], r['model'] or r['name'])
        bills[key] = bills.get(key, Decimal(0)) + Decimal(r['cost'])
    for key, value in bills.items():
        if key not in groups: raise ValueError('Cost without matching usage')
        if abs(Decimal(groups[key]['calculatedCost']) - value) > Decimal('0.000001'):
            raise ValueError('Amount and cost do not reconcile')
    if set(groups) != set(bills): raise ValueError('Usage missing cost')
    rows = sorted(groups.values(), key=lambda r: (r['start'], r['name']))
    for r in rows:
        r['actualCost'] = str(bills[(r['start'], r['end'], r['model'] or r['name'])])
    normalized = dict(version=1, provider='deepseek', keyName='qqbot', currency='CNY', start=min(r['start'] for r in rows), end=max(r['end'] for r in rows), rows=rows,
        actualCost=str(sum(bills.values())), costScope='费用表无 API Key 维度；与 qqbot 用量逐日逐项目校验一致，包含赠金与付费钱包。')
    normalized['id'] = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()
    return normalized

if __name__ == '__main__':
    print(json.dumps(normalize(*sys.argv[1:]), ensure_ascii=False))
