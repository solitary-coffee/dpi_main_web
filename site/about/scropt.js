document.addEventListener('DOMContentLoaded', function() {
    const slides = document.querySelector('.slides');
    const images = document.querySelectorAll('.slides img');
    const prevBtn = document.querySelector('.prev-btn');
    const nextBtn = document.querySelector('.next-btn');

    // 画像がない場合は何もしない
    if (images.length === 0) return;

    let currentIndex = 0;
    const totalImages = images.length;

    // スライドを移動させる関数
    function goToSlide(index) {
        if (index < 0) {
            index = totalImages - 1;
        } else if (index >= totalImages) {
            index = 0;
        }
        slides.style.transform = `translateX(-${index * 100}%)`;
        currentIndex = index;
    }

    // 「次へ」ボタンのクリックイベント
    nextBtn.addEventListener('click', () => {
        goToSlide(currentIndex + 1);
    });

    // 「前へ」ボタンのクリックイベント
    prevBtn.addEventListener('click', () => {
        goToSlide(currentIndex - 1);
    });
});