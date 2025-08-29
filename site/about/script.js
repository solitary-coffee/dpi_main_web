document.addEventListener('DOMContentLoaded', function() {
    
    // --- メニュー開閉機能 ---
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.overlay');

    if (menuToggleBtn && sidebar && overlay) {
        // ハンバーガーボタンをクリックした時
        menuToggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('open');
        });

        // オーバーレイをクリックした時
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
        });
    }

    // --- スライドショー機能（既存のコード） ---
    const slides = document.querySelector('.slides');
    if (slides) {
        const images = document.querySelectorAll('.slides img');
        const prevBtn = document.querySelector('.prev-btn');
        const nextBtn = document.querySelector('.next-btn');

        if (images.length > 0) {
            let currentIndex = 0;
            const totalImages = images.length;

            function goToSlide(index) {
                if (index < 0) {
                    index = totalImages - 1;
                } else if (index >= totalImages) {
                    index = 0;
                }
                slides.style.transform = `translateX(-${index * 100}%)`;
                currentIndex = index;
            }

            nextBtn.addEventListener('click', () => {
                goToSlide(currentIndex + 1);
            });

            prevBtn.addEventListener('click', () => {
                goToSlide(currentIndex - 1);
            });
        }
    }
        const commandTriggers = document.querySelectorAll('.command-trigger');

    commandTriggers.forEach(trigger => {
        trigger.addEventListener('click', function() {
            // クリックされたボタンに active クラスを付け外しする
            this.classList.toggle('active');

            // クリックされたボタンのすぐ隣の要素（command-content）を取得
            const content = this.nextElementSibling;

            // コンテンツの表示・非表示を切り替える
            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    });
});