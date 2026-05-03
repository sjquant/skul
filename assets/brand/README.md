# Brand Assets

`skul` 브랜드 아이콘 자산입니다. CLI 저장소이기 때문에 현재 웹 엔트리에는 연결하지 않았고, 이후 웹사이트나 문서에서 그대로 재사용할 수 있도록 원본과 favicon 세트를 같이 보관합니다.

## Files

- `skul-icon.svg`: 앱 아이콘, 소셜 카드, 저장소 대표 이미지에 맞춘 기본형
- `skul-mark.svg`: 투명 배경 마크. 문서, 웹, 배지, 오버레이용
- `favicon.svg`: 작은 크기에서 식별성을 유지하도록 단순화한 웹 favicon 원본
- `favicon-16x16.png`, `favicon-32x32.png`, `favicon.ico`: 브라우저 기본 favicon 세트
- `apple-touch-icon.png`: iOS 홈 화면 아이콘
- `android-chrome-192x192.png`, `android-chrome-512x512.png`: PWA/manifest용 아이콘

## Suggested Web Usage

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

```json
{
  "name": "skul",
  "icons": [
    {
      "src": "/android-chrome-192x192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/android-chrome-512x512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```
